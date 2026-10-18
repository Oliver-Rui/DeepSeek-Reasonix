"use strict";
// A page the agent lays out in a viewport of its own (a resize) is shown whole in the panel, not cropped to its
// top-left corner: scaled down to fit and centred, with the agent's clicks still landing where they were aimed.
// Run with `pnpm browser-fit-live`; it needs no network. SHOTS=<dir> also writes pictures of the window.
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { app, BrowserWindow } = require("electron");
const { BrowserViews } = require("../src/browserviews");
const { checker } = require("./livekit");

const PAGE = `<!doctype html><title>wide</title><style>body{margin:0;font:20px sans-serif}.bar{display:flex;justify-content:space-between;background:#1a56db;color:#fff;padding:14px;width:1280px;box-sizing:border-box}.c{width:1280px;height:600px;background:linear-gradient(90deg,#fde68a,#a7f3d0);position:relative}.r{position:absolute;right:10px;top:10px;background:#111;color:#fff;padding:8px}</style><div class=bar><b>LEFT edge</b><b>RIGHT edge</b></div><div class=c><span class=r id=rc onclick="document.title='hit'">right column</span></div>`;
const { check, failures } = checker();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const server = http.createServer((_q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const win = new BrowserWindow({ width: 1000, height: 760, show: true });
  await win.loadURL("data:text/html,<body style='margin:0;background:%23ddd;font:14px sans-serif'><div style='position:absolute;left:20px;top:20px'>app chrome</div>");
  const views = new BrowserViews({ win, kernelOrigin: "http://127.0.0.1:1" });
  const page = views.create({ partition: "fit", url: `http://127.0.0.1:${server.address().port}/`, onEvent() {}, onClosed() {}, onPopup() {}, onDownload() {} });
  const view = views.entries.get(page.targetId).view;
  await wait(1500);
  const evalIn = (expression) => page.send("Runtime.evaluate", { expression, returnByValue: true }).then((r) => r.result.value);
  const shot = (name) => {
    if (!process.env.SHOTS) return;
    fs.mkdirSync(process.env.SHOTS, { recursive: true });
    win.focus();
    const b = win.getBounds();
    execFileSync("screencapture", ["-x", "-R", `${b.x},${b.y},${b.width},${b.height}`, `${process.env.SHOTS}/${name}.png`]);
  };
  const click = async () => {
    await evalIn("document.title='reset'");
    const r = JSON.parse(await evalIn("JSON.stringify(document.getElementById('rc').getBoundingClientRect())"));
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: r.x + r.width / 2, y: r.y + r.height / 2, button: "left", clickCount: 1 });
    }
    await wait(250);
    return evalIn("document.title");
  };
  const panel = { x: 380, y: 60, width: 560, height: 620 };
  views.show(page.targetId, panel);
  await wait(600);
  check("no resize: the page fills the panel as before", JSON.stringify(view.getBounds()) === JSON.stringify(panel));

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 0, mobile: false });
  await wait(600);
  const fit = view.getBounds();
  check("a 1280x900 viewport in a 560x620 panel: the view is scaled to 560x394 and centred", fit.width === 560 && fit.height === 394 && fit.x === 380 && fit.y === 173, JSON.stringify(fit));
  check("the page still lays out at the viewport it was given", (await evalIn("innerWidth")) === 1280);
  check("an agent click aimed at the right column lands on it", (await click()) === "hit");
  shot("fit-in-panel");

  views.show(page.targetId, { x: 380, y: 60, width: 400, height: 500 });
  await wait(600);
  const narrower = view.getBounds();
  check("a narrower panel re-fits the view", narrower.width === 400 && narrower.height === 281, JSON.stringify(narrower));
  check("and the click still lands", (await click()) === "hit");

  views.show(page.targetId, { x: 20, y: 20, width: 1400, height: 1000 });
  await wait(600);
  const roomy = view.getBounds();
  check("a panel larger than the viewport shows it at full size, centred, never enlarged", roomy.width === 1280 && roomy.height === 900 && roomy.x === 80 && roomy.y === 70, JSON.stringify(roomy));
  check("and the click lands at full size", (await click()) === "hit");

  views.hide();
  await wait(600);
  check("parked, the page is not scaled and the click lands", (await click()) === "hit");

  views.show(page.targetId, panel);
  await wait(600);
  check("shown again it is fitted again", view.getBounds().width === 560 && (await click()) === "hit");

  await page.send("Emulation.clearDeviceMetricsOverride", {});
  await wait(600);
  check("clearing the viewport gives the page its panel back", JSON.stringify(view.getBounds()) === JSON.stringify(panel) && (await evalIn("innerWidth")) === 560);
  shot("cleared");

  console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
  app.exit(failures.length ? 1 : 0);
});
