"use strict";
const crypto = require("node:crypto");
const { WebContentsView, session } = require("electron");
const { installPaneReload } = require("./reload");
const { guestNavigationAllowed, typed } = require("./browserguard");
const { InputWake } = require("./inputwake");
const { KeyboardKeeper } = require("./keyboard");

// The size a page lays out at while nobody is looking at it: the kernel drives
// pages whether or not the panel is open, and a page sized to nothing reads as
// a phone layout or not at all.
const AGENT_VIEWPORT = { width: 1280, height: 900 };

// How long a page may be held out of the window while its navigation runs. A
// server that accepts the connection and never answers would otherwise keep the
// panel blank, with nothing turning, for as long as it likes; past this the page
// is shown again, loaded or not.
const LEAVE_LIMIT_MS = 4000;

// CSS cannot clip a native view, so the page's corners are rounded here; the
// value is .bview's border-radius in studio.css, whose rect the view fills.
const PAGE_RADIUS = 8;

// BrowserViews owns the pages the agent's browser opens in this window. Each is
// a view on its own partition — never the session the window's credential
// lives in. A page nobody is watching is not hidden and not moved wholly off
// screen: Chromium lays out nothing outside the window, and a page it created
// while its view was hidden takes no input until shown. It is kept overlapping
// the window by one pixel in the bottom-left corner instead.
class BrowserViews {
  constructor({ win, kernelOrigin }) {
    this.win = win;
    this.kernelOrigin = kernelOrigin;
    this.entries = new Map();
    this.guarded = new Set();
    this.logins = new Map();
    // host + certificate fingerprint pairs the person chose to proceed past,
    // for this run only: a restart, or a different certificate, asks again.
    this.trusted = new Set();
    this.shown = "";
    this.keyboard = new KeyboardKeeper({ win });
    this.wake = new InputWake({ win });
    // Moves with every show and hide, so a freeze that finishes after one does
    // not put away a page shown since.
    this.placed = 0;
    win.on("resize", () => {
      for (const [id, entry] of this.entries) if (id !== this.shown) this.putAway(entry.view);
    });
    // A page in a minimized window keeps its widget hidden, and a hidden widget
    // drops the input the agent sends it — the protocol call does not even
    // answer. Attaching the view again is what brings the widget back.
    for (const state of ["minimize", "restore", "hide", "show"]) win.on(state, () => this.reattach());
  }

  // guard fixes what every page on a partition may do: ask for no permission,
  // download nothing, and reach nothing on the kernel's origin, from any frame.
  guard(partition) {
    if (this.guarded.has(partition)) return;
    this.guarded.add(partition);
    const ses = session.fromPartition("persist:" + partition);
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, done) => {
      let cancel = false;
      try {
        cancel = new URL(details.url).origin === this.kernelOrigin;
      } catch {
        cancel = false;
      }
      done({ cancel });
    });
    ses.on("will-download", (event, item, contents) => {
      event.preventDefault();
      for (const entry of this.entries.values()) {
        if (entry.view.webContents === contents) {
          entry.onDownload({ url: item.getURL(), suggestedFilename: item.getFilename() });
        }
      }
    });
  }

  create({ partition, url, onEvent, onClosed, onPopup, onDownload }) {
    this.guard(partition);
    const targetId = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:" + partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    view.setBorderRadius(PAGE_RADIUS);
    const contents = view.webContents;
    let mainFrame = "";
    const allowed = (to) => guestNavigationAllowed(to, this.kernelOrigin);
    contents.on("will-navigate", (event, to) => {
      if (!allowed(to)) event.preventDefault();
    });
    contents.on("will-redirect", (event, to) => {
      if (!allowed(to)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url: to }) => {
      if (allowed(to)) onPopup(to);
      return { action: "deny" };
    });
    installPaneReload(contents);
    contents.debugger.attach("1.3");
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      if (sessionId) return;
      if (method === "Page.frameNavigated" && params && params.frame && !params.frame.parentId) {
        mainFrame = params.frame.id;
      }
      onEvent(method, params);
    });
    const entry = { view, onDownload, typed: 0, synthUntil: 0, attached: false, panel: null, override: null, scale: 1 };
    this.keyboard.watch(contents, () => Date.now() < entry.synthUntil);
    this.watchLoads(targetId, entry);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.entries.delete(targetId);
      clearTimeout(entry.returning);
      if (entry.attached && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      entry.attached = false;
      if (!contents.isDestroyed()) contents.close();
      onClosed();
    };
    contents.once("destroyed", close);
    contents.on("render-process-gone", close);
    this.entries.set(targetId, entry);
    // The page loads before the window holds it: a page that finishes loading in a
    // view already attached is given the keyboard by the platform, and the
    // person's composition in the app page ends with it.
    void contents.loadURL(url).catch(() => {});
    return {
      targetId,
      send: (method, params) => {
        if (method === "Emulation.setDeviceMetricsOverride") return this.emulate(entry, params);
        if (method === "Emulation.clearDeviceMetricsOverride") return this.emulate(entry, null);
        try {
          params = scaleInput(method, params, entry.scale);
        } catch (e) {
          return Promise.reject(e);
        }
        if (!method.startsWith("Input.")) return contents.debugger.sendCommand(method, params);
        entry.synthUntil = Date.now() + 250;
        return this.wake.run(() => contents.debugger.sendCommand(method, params));
      },
      close,
      mainFrame: () => mainFrame,
    };
  }

  // show draws one page over the rectangle the page reserved for it, in window
  // coordinates, and puts every other page away.
  show(targetId, rect) {
    const entry = this.entries.get(targetId);
    if (!entry || !validRect(rect)) return this.hide();
    const at = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    // The panel reports its rectangle whenever anything in the window changes,
    // which during a turn is constantly, and nearly always the same rectangle:
    // re-adding the view and setting the bounds it already has is work for
    // every one of those.
    if (this.shown === targetId && sameRect(entry.panel, at)) return;
    this.placed++;
    for (const [id, other] of this.entries) {
      if (id !== targetId) this.putAway(other.view, other);
    }
    this.shown = targetId;
    // A page that was parked comes back as a view that is attached but whose
    // widget never repaints until the window's geometry changes; attaching it
    // again is what wakes it, the same as after a minimize.
    if (entry.attached && !entry.at) this.win.contentView.removeChildView(entry.view);
    this.win.contentView.addChildView(entry.view);
    entry.attached = true;
    entry.panel = at;
    this.fit(entry);
    this.keepKeyboard();
  }

  // fit puts the view where its page is drawn whole and tells the page how it
  // is scaled; a page parked out of sight is not scaled.
  fit(entry) {
    const { at, scale } = placement(entry.panel, entry.override && { width: entry.override.width, height: entry.override.height });
    entry.view.setBounds(at);
    entry.at = at;
    return this.scaled(entry, scale);
  }

  scaled(entry, scale) {
    if (!entry.override || entry.scale === scale) return Promise.resolve();
    entry.scale = scale;
    return this.override(entry).catch(() => {});
  }

  override(entry) {
    const params = entry.scale === 1 ? entry.override : { ...entry.override, scale: entry.scale };
    return entry.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", params);
  }

  // emulate records the viewport a page was told to lay out in, which the view
  // is then fitted to; null is the page going back to the size of its view.
  async emulate(entry, params) {
    entry.override = params ? { ...params } : null;
    if (!params) {
      entry.scale = 1;
      if (entry.panel) this.fit(entry);
      return entry.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {});
    }
    entry.scale = 1;
    if (entry.panel) {
      const { at, scale } = placement(entry.panel, entry.override);
      entry.view.setBounds(at);
      entry.at = at;
      entry.scale = scale;
    }
    return this.override(entry);
  }

  // Attaching a view can leave nobody holding the keyboard, and the platform
  // settles that a moment later, so the page is handed it back twice.
  keepKeyboard() {
    this.keyboard.reclaim();
    setTimeout(() => this.keyboard.reclaim(), 150);
  }

  reattach() {
    for (const [id, entry] of this.entries) {
      if (this.win.isDestroyed() || entry.view.webContents.isDestroyed() || !entry.attached) continue;
      this.win.contentView.removeChildView(entry.view);
      this.win.contentView.addChildView(entry.view);
      if (id !== this.shown) this.putAway(entry.view, entry);
    }
    this.keepKeyboard();
  }

  // A navigation that starts in an attached view takes the keyboard from the app
  // page when it finishes, and a composition in progress there is committed as
  // the raw letters. While the app page holds the keyboard the view is held out of
  // the window for the length of the navigation, and put back when it ends; a
  // person who is in the page themselves keeps it where it is.
  leave(entry) {
    if (!entry.attached || this.win.isDestroyed() || this.keyboard.owner !== "app") return;
    this.win.contentView.removeChildView(entry.view);
    entry.attached = false;
    clearTimeout(entry.returning);
    entry.returning = setTimeout(() => this.settle(entry), LEAVE_LIMIT_MS);
  }

  settle(entry) {
    clearTimeout(entry.returning);
    entry.returning = undefined;
    if (entry.attached || this.win.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    this.win.contentView.addChildView(entry.view);
    entry.attached = true;
    if (entry.at) entry.view.setBounds(entry.at);
    else this.putAway(entry.view, entry);
  }

  // freeze answers with a picture of the page on screen, taken before it is put
  // away, for the window to draw in its place while something of its own is
  // over it. Only the page already shown to the person is ever taken, and the
  // picture goes to this window's page and nowhere else.
  async freeze() {
    const id = this.shown;
    const entry = this.entries.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) {
      this.hide();
      return "";
    }
    const turn = this.placed;
    let picture = "";
    try {
      const image = await entry.view.webContents.capturePage();
      if (!image.isEmpty()) picture = "data:image/jpeg;base64," + image.toJPEG(85).toString("base64");
    } catch {
      picture = "";
    }
    if (this.placed === turn && this.shown === id) this.hide();
    return picture;
  }

  hide() {
    this.placed++;
    this.shown = "";
    for (const entry of this.entries.values()) this.putAway(entry.view, entry);
  }

  putAway(view, entry) {
    const { height } = this.win.getContentBounds();
    view.setBounds({ x: 1 - AGENT_VIEWPORT.width, y: height - 1, ...AGENT_VIEWPORT });
    if (entry) {
      entry.at = null;
      entry.panel = null;
      void this.scaled(entry, 1);
    }
  }

  control(targetId, action) {
    const contents = this.entries.get(targetId)?.view.webContents;
    if (!contents) return;
    const history = contents.navigationHistory;
    switch (action) {
      case "back":
        if (history.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history.canGoForward()) history.goForward();
        break;
      case "reload":
        contents.reload();
        break;
      case "stop":
        contents.stop();
        break;
    }
  }

  // navigate starts loading what the person typed and answers "", or the code
  // of why the window will not: "scheme" or "network_file".
  navigate(targetId, address) {
    const entry = this.entries.get(targetId);
    const { url, fallback, refusal } = typed(address, this.kernelOrigin);
    if (!entry) return "scheme";
    if (refusal) return refusal;
    void this.loadTyped(targetId, entry, url, fallback);
    return "";
  }

  // loadTyped owns the outcome of an address the person typed. loadURL's own
  // answer is read rather than did-fail-load: a refused port or scheme never
  // starts a navigation, so no event would say why nothing happened.
  async loadTyped(targetId, entry, url, fallback) {
    const turn = ++entry.typed;
    const contents = entry.view.webContents;
    let failed = await loadResult(contents, url);
    if (failed && fallback && entry.typed === turn) failed = await loadResult(contents, fallback);
    if (entry.typed !== turn) return;
    entry.typed = 0;
    if (failed) this.report(targetId, failed, entry);
  }

  // watchLoads tells the window why a page did not load, since Electron draws
  // no error page of its own, and answers a login a page or a proxy asks for
  // with what the person types rather than cancelling it.
  watchLoads(targetId, entry) {
    const contents = entry.view.webContents;
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.report(targetId, null);
      this.leave(entry);
    });
    contents.on("did-stop-loading", () => this.settle(entry));
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, or stopped. A
      // typed address reports through loadTyped, which may still retry it.
      if (!isMainFrame || code === -3 || entry.typed) return;
      this.report(targetId, { url, code, reason: description }, entry);
    });
    // Electron rejects a certificate it cannot verify unless told otherwise,
    // and only a pair the person trusted through trustCertificate is.
    contents.on("certificate-error", (event, url, error, certificate, callback, isMainFrame) => {
      const host = hostOf(url);
      if (this.trusted.has(trustKey(host, certificate.fingerprint))) {
        event.preventDefault();
        callback(true);
        return;
      }
      if (isMainFrame) {
        entry.certificate = {
          host,
          url,
          error,
          fingerprint: certificate.fingerprint,
          subject: certificate.subjectName,
          issuer: certificate.issuerName,
          expiry: certificate.validExpiry,
        };
      }
    });
    contents.on("login", (event, details, authInfo, callback) => {
      event.preventDefault();
      const id = crypto.randomUUID();
      this.logins.set(id, callback);
      this.send("browser:login", {
        id,
        targetId,
        url: details.url,
        host: authInfo.host,
        port: authInfo.port,
        realm: authInfo.realm,
        proxy: authInfo.isProxy,
      });
    });
  }

  // answerLogin settles one login the window was asked for. No answer, or an
  // empty one, cancels it the way Electron would have.
  answerLogin(id, username, password) {
    const callback = this.logins.get(id);
    if (!callback) return;
    this.logins.delete(id);
    if (username) callback(username, password);
    else callback();
  }

  report(targetId, failure, entry) {
    const cert = entry?.certificate;
    if (failure && cert && failure.reason.startsWith("ERR_CERT_") && cert.host === hostOf(failure.url)) {
      const { host, error, fingerprint, subject, issuer, expiry } = cert;
      failure = { ...failure, certificate: { host, error, fingerprint, subject, issuer, expiry } };
    }
    this.send("browser:load-state", { targetId, failure });
  }

  // trustCertificate proceeds past the certificate a page's last load was
  // refused for. It is reached only from the window's own page, so neither
  // the kernel nor the agent driving the browser can trust one.
  trustCertificate(targetId) {
    const entry = this.entries.get(targetId);
    const cert = entry?.certificate;
    if (!cert) return false;
    this.trusted.add(trustKey(cert.host, cert.fingerprint));
    entry.certificate = null;
    void this.loadTyped(targetId, entry, cert.url, "");
    return true;
  }

  send(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  closeAll() {
    for (const id of [...this.logins.keys()]) this.answerLogin(id);
    for (const entry of [...this.entries.values()]) entry.view.webContents.close();
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
}

function trustKey(host, fingerprint) {
  return `${host} ${fingerprint}`;
}

// loadResult is null when the page loaded, or why it did not. An abort is
// another navigation taking over, which is not a failure of this one.
async function loadResult(contents, url) {
  try {
    await contents.loadURL(url);
    return null;
  } catch (err) {
    if (err?.code === "ERR_ABORTED") return null;
    return { url: err?.url || url, code: Number(err?.errno) || 0, reason: String(err?.code || "") };
  }
}

// Where a page's view sits in the rectangle the panel gave it. A page laid out
// in a viewport of its own is shown whole: scaled down to fit and never up,
// centred, with the view sized to exactly what it draws.
function placement(panel, emulated) {
  if (!emulated) return { at: panel, scale: 1 };
  const scale = Math.min(1, panel.width / emulated.width, panel.height / emulated.height);
  const width = Math.max(1, Math.round(emulated.width * scale));
  const height = Math.max(1, Math.round(emulated.height * scale));
  const x = panel.x + Math.round((panel.width - width) / 2);
  const y = panel.y + Math.round((panel.height - height) / 2);
  return { at: { x, y, width, height }, scale };
}

// Input that carries a point. The page reads it in the viewport it was told it
// has, the view draws that viewport scaled, and a point meant for the page lands
// where it is drawn only after the same scaling. The mouse is measured to; the
// rest are not, and a point that silently lands elsewhere is worse than a
// refusal, so they are refused while the page is scaled.
const POINTED_INPUT = new Set([
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
  "Input.emulateTouchFromMouseEvent",
  "Input.synthesizeTapGesture",
  "Input.synthesizeScrollGesture",
  "Input.synthesizePinchGesture",
]);

function scaleInput(method, params, scale) {
  if (scale === 1) return params;
  if (method === "Input.dispatchMouseEvent") return { ...params, x: params.x * scale, y: params.y * scale };
  if (POINTED_INPUT.has(method)) {
    throw Object.assign(new Error(`${method} is not available while the page is scaled to fit the panel`), { code: "input_unscaled" });
  }
  return params;
}

function sameRect(a, b) {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function validRect(rect) {
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

module.exports = { BrowserViews, AGENT_VIEWPORT, LEAVE_LIMIT_MS, placement, scaleInput };
