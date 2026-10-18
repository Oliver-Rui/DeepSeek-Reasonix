// Reasonix mod host. Embedded in the binary and written under the state root;
// it loads one Claude Code hooks module and speaks the Extension Protocol v2 for
// it over NDJSON on stdio. usage: host.mjs <module> <pluginRoot> <pluginName> <configJSON>
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { register as registerLoader } from "node:module";

const [, , MODULE, PLUGIN_ROOT, PLUGIN_NAME, CONFIG_JSON] = process.argv;
const CONFIG = JSON.parse(CONFIG_JSON || "{}");
const LIMITS = { hookMs: CONFIG.hookMs ?? 10_000, catchMs: CONFIG.catchMs ?? 1_000, fileBytes: 4 << 20, httpBytes: 4 << 20, storeBytes: 4 << 20, processMs: 30_000, processMaxMs: 600_000, redirects: 5, fetchMs: 30_000 };

// The mod's console and stdout must never reach the wire.
const wire = process.stdout.write.bind(process.stdout);
process.stdout.write = (...a) => process.stderr.write(...a);
for (const k of ["log", "info", "debug"]) console[k] = (...a) => console.error(...a);

const send = (o) => wire(JSON.stringify(o) + "\n");
const diag = (code, message) => console.error(`[${PLUGIN_NAME}] ${code}: ${message}`);

class ModError extends Error {
  constructor(code, message) { super(message); this.name = "ModError"; this.code = code; }
}
const unsupported = (member) => new ModError("mod.unsupported", `${member} is not served by this host`);

// ---- events -----------------------------------------------------------------
// Every event Claude Code names. One this host does not raise is registered and
// reported, never silently dropped; a name that is not Claude's fails register.
const CLAUDE_EVENTS = new Set(`tool.call tool.check tool.describe prompt.submit prompt.fill prompt.suggest prompt.edit prompt.autocomplete prompt.compose prompt.section prompt.context prompt.attachment prompt.mention skill.prompt attribution.text command.run command.describe config.set config.describe turn.start turn.step turn.complete session.start session.end session.compact session.receive session.send session.append session.attach session.detach session.measure agent.offer agent.spawn ui.render ui.resolve ui.press ui.input ui.select ui.focus ui.scroll ui.close ui.message ui.fault plugin.register engine.create telemetry.log telemetry.mark`.split(/\s+/));
const SERVED = new Set(["tool.call", "tool.check", "prompt.submit", "session.start", "session.end", "turn.start", "ui.render", "ui.press", "command.run"]);
// Every mods API method is also an event; the unserved ones are named the same way.
const API_EVENTS = new Set(`ui.resolve ui.invalidate ui.open ui.close ui.panes ui.focus ui.scroll ui.toast ui.status ui.log ui.notice ui.ask ui.copy ui.selection ui.blit command.register command.run command.list tool.register tool.call tool.check tool.list agent.register agent.spawn agent.list model.complete model.fork model.classify prompt.submit prompt.read prompt.fill prompt.suggest prompt.compose turn.abort session.messages session.cwd session.root session.model session.turns session.id session.repo session.surfaces session.usage session.version session.compact session.send session.append session.authorize config.list config.set settings.read env.get env.set fs.read fs.write fs.list fs.exists fs.stat fs.ancestors store.get store.set store.delete store.keys state.get state.set clock.now clock.sleep clock.after clock.every http.fetch process.run process.spawn mcp.call mcp.connect audio.play audio.speak telemetry.log telemetry.mark`.split(/\s+/));

const regs = new Map(); // event -> [{matcher, fn, onError, order}]
const unserved = new Set();
let order = 0;

function on(event, matcherOrHook, maybeHook) {
  const hook = typeof matcherOrHook === "function" ? matcherOrHook : maybeHook;
  const matcher = typeof matcherOrHook === "function" ? undefined : matcherOrHook;
  if (typeof event !== "string" || typeof hook !== "function") throw new ModError("mod.bad_register", "on(event, [matcher], hook) needs an event name and a function");
  if (!CLAUDE_EVENTS.has(event) && !event.startsWith("classic.") && !API_EVENTS.has(event)) throw new ModError("mod.unknown_event", `${event} is not an event Claude Code names`);
  if (!SERVED.has(event)) unserved.add(event);
  const reg = { matcher, fn: hook, onError: null, order: order++ };
  if (!regs.has(event)) regs.set(event, []);
  regs.get(event).push(reg);
  return { catch(handler) { reg.onError = handler; return this; } };
}

function matches(matcher, e) {
  if (!matcher) return true;
  return Object.entries(matcher).every(([k, v]) => {
    const got = e?.[k];
    if (v instanceof RegExp) return typeof got === "string" && v.test(got);
    if (typeof v === "string" && v.endsWith("*")) return typeof got === "string" && got.startsWith(v.slice(0, -1));
    return got === v;
  });
}

const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const clone = (o) => (o === undefined ? undefined : structuredClone(o));

// One hook's own running time counts, the time it waits in next() or a $ call does not.
function budgeted(ms, run) {
  return new Promise((resolve, reject) => {
    let left = ms, started = Date.now(), timer = null, done = false;
    const arm = () => { started = Date.now(); timer = setTimeout(() => { if (!done) { done = true; reject(new ModError("mod.hook_timeout", `a hook ran past its ${ms} ms`)); } }, Math.max(left, 1)); };
    const pause = () => { if (timer) { clearTimeout(timer); timer = null; left -= Date.now() - started; } };
    const control = { pause, resume: () => { if (!done && !timer) arm(); }, get remaining() { return Math.max(left - (timer ? Date.now() - started : 0), 0); } };
    arm();
    Promise.resolve().then(() => run(control)).then((v) => { if (!done) { done = true; pause(); resolve(v); } }, (e) => { if (!done) { done = true; pause(); reject(e); } });
  });
}

async function runChain(event, e0, terminal, extra = {}) {
  const list = (regs.get(event) ?? []).filter((r) => matches(r.matcher, e0));
  const stats = { calls: 0, timeouts: 0, threw: 0 };
  async function at(i, e) {
    if (i >= list.length) return terminal(e);
    const r = list[i];
    stats.calls++;
    let called = false, downstream;
    try {
      return await budgeted(LIMITS.hookMs, async (ctl) => {
        const next = async (ev) => {
          called = true; ctl.pause();
          try { downstream = await at(i + 1, ev === undefined ? e : ev); return downstream; } finally { ctl.resume(); }
        };
        next.signal = new AbortController().signal;
        next.origin = { plugin: "engine", tier: "core" };
        next.budget = { ms: LIMITS.hookMs, get remainingMs() { return ctl.remaining; } };
        next.to = () => { throw unsupported("next.to"); };
        return await r.fn($, deepFreeze(clone(e)), next);
      });
    } catch (err) {
      const kind = err?.code === "mod.hook_timeout" ? "timeout" : "throw";
      stats[kind === "timeout" ? "timeouts" : "threw"]++;
      diag(err?.code ?? "mod.hook_threw", String(err?.message ?? err));
      if (r.onError) {
        try { await budgeted(LIMITS.catchMs, async () => r.onError($, deepFreeze(clone(e)), Object.assign(() => undefined, { error: { kind, message: String(err?.message ?? err) }, called }))); } catch {}
      }
      return called ? downstream : at(i + 1, e);
    } finally { totals.calls += 0; }
  }
  const out = await at(0, e0);
  totals.calls += stats.calls; totals.timeouts += stats.timeouts; totals.threw += stats.threw;
  return out;
}
const totals = { calls: 0, timeouts: 0, threw: 0 };

// ---- the mods API ($) -------------------------------------------------------
const stateDir = CONFIG.stateDir ?? path.join(PLUGIN_ROOT, ".state");
const session = { id: CONFIG.sessionId ?? "", cwd: CONFIG.workspaceRoot ?? process.cwd(), root: CONFIG.workspaceRoot ?? process.cwd(), model: "", turns: 0 };
const registeredTools = new Map();
const registeredCommands = new Map();
let registering = false;
let startRan = false;

const rejectUnsupported = (ns) => new Proxy({}, { get: (_, member) => (typeof member === "string" ? async () => { throw unsupported(`$.${ns}.${member}`); } : undefined) });

async function readFileCapped(p) {
  const st = await fsp.stat(p);
  if (st.size > LIMITS.fileBytes) throw new ModError("mod.limit", `${p} is over the ${LIMITS.fileBytes}-byte limit`);
  return fsp.readFile(p, "utf8");
}
const inSession = (p) => path.resolve(session.cwd, p);

function runProcess(spec, opts = {}) {
  const argv = Array.isArray(spec) ? spec : spec.argv;
  const options = Array.isArray(spec) ? opts : spec;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) throw new ModError("mod.bad_call", "process.run takes an argv array of strings");
  const ms = Math.min(options.timeoutMs ?? LIMITS.processMs, LIMITS.processMaxMs);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd ? inSession(options.cwd) : session.cwd, env: { ...process.env, ...(options.env ?? {}) }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, ms);
    child.stdout.on("data", (d) => { if (stdout.length < LIMITS.httpBytes) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < LIMITS.httpBytes) stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(new ModError("mod.process_failed", String(err.message))); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut: killed }); });
    if (options.input != null) child.stdin.end(String(options.input)); else child.stdin.end();
  });
}

async function storeFile() { await fsp.mkdir(stateDir, { recursive: true }); return path.join(stateDir, "store.json"); }
let storeCache = null;
async function storeLoad() {
  if (storeCache) return storeCache;
  try { storeCache = JSON.parse(await fsp.readFile(await storeFile(), "utf8")); } catch { storeCache = {}; }
  return storeCache;
}
async function storeSave() {
  const text = JSON.stringify(storeCache);
  if (Buffer.byteLength(text) > LIMITS.storeBytes) throw new ModError("mod.limit", `$.store is over ${LIMITS.storeBytes} bytes`);
  await fsp.writeFile(await storeFile(), text);
}

const atoms = new Map();
const $ = {
  plugin: { name: PLUGIN_NAME, root: PLUGIN_ROOT },
  state: {
    get: async (src) => (atoms.has(`${src.plugin}.${src.key}`) ? atoms.get(`${src.plugin}.${src.key}`) : src.default),
    set: async (src, value) => { atoms.set(`${src.plugin}.${src.key}`, value); scheduleRedraw(); },
  },
  store: {
    get: async (k) => (await storeLoad())[k],
    set: async (k, v) => { (await storeLoad())[k] = v; await storeSave(); },
    delete: async (k) => { delete (await storeLoad())[k]; await storeSave(); },
    keys: async () => Object.keys(await storeLoad()),
  },
  clock: {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    after: (ms, fn) => { const t = setTimeout(() => { Promise.resolve().then(fn).catch((e) => diag("mod.hook_threw", String(e))); }, ms); return () => clearTimeout(t); },
    every: (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => diag("mod.hook_threw", String(e))); }, ms); return () => clearInterval(t); },
  },
  fs: {
    read: async (p) => readFileCapped(inSession(p)),
    write: async (p, text) => { if (Buffer.byteLength(String(text)) > LIMITS.fileBytes) throw new ModError("mod.limit", "file over the write limit"); await fsp.mkdir(path.dirname(inSession(p)), { recursive: true }); await fsp.writeFile(inSession(p), String(text)); },
    list: async (p = ".") => fsp.readdir(inSession(p)),
    exists: async (p) => fsp.access(inSession(p)).then(() => true, () => false),
    stat: async (p) => { const s = await fsp.stat(inSession(p)); return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs }; },
    ancestors: async (p) => { const out = []; let d = path.dirname(inSession(p)); for (;;) { out.push(d); const up = path.dirname(d); if (up === d) break; d = up; } return out; },
  },
  process: { run: (spec, opts) => runProcess(spec, opts), spawn: async () => { throw unsupported("$.process.spawn"); } },
  http: {
    fetch: async (url, init = {}) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), LIMITS.fetchMs);
      try {
        const body = init.body;
        if (typeof body === "string" && body.length > LIMITS.httpBytes) throw new ModError("mod.limit", "request body over 4 MiB");
        const res = await fetch(url, { ...init, signal: ctl.signal, redirect: "follow" });
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > LIMITS.httpBytes && init.method !== "HEAD") throw new ModError("mod.limit", `${declared} bytes is over the ${LIMITS.httpBytes}-byte limit`);
        const buf = Buffer.from(await res.arrayBuffer()).subarray(0, LIMITS.httpBytes);
        return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text: buf.toString("utf8") };
      } finally { clearTimeout(timer); }
    },
  },
  env: { get: (k) => process.env[k], set: async () => { throw unsupported("$.env.set"); } },
  session: {
    id: () => session.id, cwd: () => session.cwd, root: () => session.root,
    model: () => session.model, turns: () => session.turns,
    messages: async () => { throw unsupported("$.session.messages"); },
    usage: async () => ({ startedAt: startedAt, context: usage.context, rateLimits: [], cost: usage.cost }),
  },
  tool: {
    register: (spec) => {
      if (!registering) throw new ModError("mod.late_register", "a tool is registered while the module loads, in session.start; it cannot be added later");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec?.name ?? "")) throw new ModError("mod.bad_call", "a tool name is letters, digits, _ and -, up to 64");
      registeredTools.set(spec.name, spec);
    },
    call: async (name, input) => { const t = registeredTools.get(name); if (!t) throw new ModError("mod.bad_call", `no tool ${name}`); return t.run ? t.run($, input) : t.execute?.($, input); },
    list: () => [...registeredTools.values()].map((t) => ({ name: t.name, description: t.description })),
    check: async () => { throw unsupported("$.tool.check"); },
  },
  command: {
    register: (spec) => {
      if (!registering) throw new ModError("mod.late_register", "a command is registered while the module loads, in session.start; it cannot be added later");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec?.name ?? "")) throw new ModError("mod.bad_call", "a command name is letters, digits, _ and -, up to 64");
      registeredCommands.set(spec.name, spec);
    },
    run: async (name, args) => { const c = registeredCommands.get(name); if (!c) throw new ModError("mod.bad_call", `no command ${name}`); return c.run?.($, args); },
    list: () => [...registeredCommands.values()].map((c) => ({ name: c.name, description: c.description })),
  },
  ui: {
    resolve: () => elements,
    invalidate: () => scheduleRedraw(),
    toast: async (text) => publishNotice("toast", String(text)),
    notice: async (text) => publishNotice("notice", String(text)),
    status: async (text) => publishStatus(String(text)),
    log: async (text) => { diag("mod.log", String(text)); },
    ask: async (q) => askUser(q),
    open: async () => ({ isPlaced: false, reason: "this host has no panes" }),
    close: async () => undefined,
    panes: () => [],
    focus: async () => { throw unsupported("$.ui.focus"); },
    scroll: async () => { throw unsupported("$.ui.scroll"); },
    copy: async () => { throw unsupported("$.ui.copy"); },
    selection: async () => { throw unsupported("$.ui.selection"); },
    blit: async () => { throw unsupported("$.ui.blit"); },
  },
  prompt: rejectUnsupported("prompt"), turn: rejectUnsupported("turn"), agent: rejectUnsupported("agent"), model: rejectUnsupported("model"),
  config: rejectUnsupported("config"), settings: rejectUnsupported("settings"), mcp: rejectUnsupported("mcp"), audio: rejectUnsupported("audio"), telemetry: rejectUnsupported("telemetry"),
};
const startedAt = Date.now();
const usage = { context: { tokens: 0, window: 0, percent: 0 }, cost: 0 };

// ---- elements, the band and its buttons -----------------------------------
const elements = {
  Box: (p = {}) => ({ el: "Box", ...p }),
  Text: (p = {}) => ({ el: "Text", ...p }),
  Button: (p = {}) => ({ el: "Button", ...p }),
  Link: (p = {}) => ({ el: "Link", ...p }),
  Markdown: (p = {}) => ({ el: "Markdown", ...p }),
  Code: (p = {}) => ({ el: "Code", ...p }),
};
for (const name of ["Input", "Select", "Svg", "Raster", "Image", "Client"]) elements[name] = () => { throw unsupported(name); };

const TONES = { red: "err", redBright: "err", green: "ok", greenBright: "ok", yellow: "warn", yellowBright: "warn", cyan: "accent", blue: "accent", magenta: "accent" };
const toneOf = (p) => (p.dimColor ? "dim" : p.bold || p.weight === "bold" || p.weight === "semibold" ? "strong" : TONES[p.color]);
const MAX_BUTTONS = 16;
let drawing = []; // slot -> onPress

function textOf(children) {
  const out = [];
  for (const c of [].concat(children ?? [])) { if (c == null || c === false) continue; out.push(typeof c === "object" ? textOf(c.children) : String(c)); }
  return out.join("");
}
function toNode(el, depth = 0) {
  if (el == null || el === false) return null;
  if (typeof el === "string" || typeof el === "number") return { kind: "text", value: String(el) };
  if (depth > 7) return { kind: "text", value: "…" };
  switch (el.el) {
    case "Text": { const v = textOf(el.children); return v ? { kind: "text", value: v.slice(0, 3900), tone: toneOf(el) } : null; }
    case "Markdown": return el.text ? { kind: "markdown", value: String(el.text).slice(0, 3900) } : null;
    case "Code": return el.source ? { kind: "markdown", value: "```" + (el.language ?? "") + "\n" + String(el.source).slice(0, 3800) + "\n```" } : null;
    case "Link": return { kind: "text", value: String(el.label ?? el.href ?? "").slice(0, 190) };
    case "Button": {
      if (drawing.length >= MAX_BUTTONS) return { kind: "text", value: String(el.label ?? ""), tone: "dim" };
      drawing.push(el.onPress);
      return { kind: "button", label: String(el.label ?? el.key ?? "").slice(0, 190), actionId: `press.${drawing.length - 1}` };
    }
    case "Box": {
      const children = [].concat(el.children ?? []).map((c) => toNode(c, depth + 1)).filter(Boolean);
      if (children.length === 0) return null;
      return { kind: el.flexDirection === "row" ? "row" : "stack", children };
    }
    default: return null;
  }
}

// ---- host RPC ---------------------------------------------------------------
let nextId = 1;
const pending = new Map();
function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
let sessionCtx = { sessionId: "", generation: 0 };
const surfaceParams = (surfaceId, kind, payload) => ({ surfaceId, sessionId: sessionCtx.sessionId, generation: sessionCtx.generation, kind, payload });
async function publishNotice(kind, text) { await callHost("host/ui/publish", surfaceParams(`mod-${kind}`, "notification", { title: `${PLUGIN_NAME}`, body: text.slice(0, 500) })); }
async function publishStatus(text) { await callHost("host/ui/publish", surfaceParams("mod-status", "status", { label: text.slice(0, 200) })); }
async function askUser(q) {
  const message = typeof q === "string" ? q : String(q?.message ?? q?.title ?? "");
  const res = await callHost("host/ui/request", { surfaceId: "mod-ask", sessionId: sessionCtx.sessionId, generation: sessionCtx.generation, kind: "input", payload: { title: `${PLUGIN_NAME} asks`, message, fields: [{ key: "answer", label: "Answer", kind: "text" }] } });
  return res.cancelled ? undefined : res.values?.answer;
}

let redrawTimer = null;
function scheduleRedraw() { if (redrawTimer || !initialized) return; redrawTimer = setTimeout(() => { redrawTimer = null; render().catch((e) => diag("mod.hook_threw", String(e))); }, 100); }
async function render() {
  if (!regs.has("ui.render")) return;
  drawing = [];
  const e = { component: "AbovePrompt", surface: "desktop", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: {}, view: {} }, requestId: "above_prompt" };
  const tree = await runChain("ui.render", e, () => null);
  const root = toNode(tree);
  if (!root) { await callHost("host/ui/publish", surfaceParams("mod-above-prompt", "view", { slot: "above_prompt", body: [{ kind: "text", value: " " }] })).catch(() => {}); return; }
  await callHost("host/ui/publish", surfaceParams("mod-above-prompt", "view", { slot: "above_prompt", body: [root] }));
}

// ---- tool name and input as Claude shows them --------------------------------
const NAMES = CONFIG.toolNames ?? {};
const RENAMES = CONFIG.toolInputRenames ?? {};
const toClaudeTool = (n) => NAMES[n] ?? n;
const toClaudeInput = (tool, args) => { const m = RENAMES[tool] ?? {}; return Object.fromEntries(Object.entries(args).map(([k, v]) => [m[k] ?? k, v])); };
const fromClaudeInput = (tool, input) => { const inv = Object.fromEntries(Object.entries(RENAMES[tool] ?? {}).map(([a, b]) => [b, a])); return Object.fromEntries(Object.entries(input).map(([k, v]) => [inv[k] ?? k, v])); };
const parseArgs = (s) => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };

// ---- intercepts -------------------------------------------------------------
const pass = { decision: "continue" };
const block = (reason) => ({ decision: "block", reason: String(reason).slice(0, 4096) });
const SAME = Symbol("same");

const intercepts = {
  "tool.before": async (p) => {
    const tool = toClaudeTool(p.name);
    const input = toClaudeInput(p.name, parseArgs(p.arguments));
    const e = { tool, input, id: p.callId };
    const out = await runChain("tool.call", e, (ev) => ({ [SAME]: ev }));
    if (out && typeof out === "object" && !(SAME in out)) {
      if (typeof out.deny === "string") return block(out.deny);
      if ("result" in out) return block(`A mod answered this call in place of the tool: ${typeof out.result === "string" ? out.result : JSON.stringify(out.result)}`);
      return pass;
    }
    const final = out?.[SAME];
    if (!final || JSON.stringify(final.input) === JSON.stringify(e.input)) return pass;
    return { decision: "replace", replacement: { name: p.name, arguments: JSON.stringify(fromClaudeInput(p.name, final.input)), callId: p.callId } };
  },
  "permission.decision": async (p) => {
    const e = { tool: toClaudeTool(p.name), input: toClaudeInput(p.name, parseArgs(p.arguments)) };
    const out = await runChain("tool.check", e, () => ({ decision: p.hostDecision }));
    const d = out?.decision;
    if (d === "deny") return { decision: "deny" };
    if (d === "ask" && p.hostDecision !== "deny") return { decision: "ask" };
    return pass;
  },
  "input.receive": async (p) => {
    const e = { text: p.text };
    const out = await runChain("prompt.submit", e, (ev) => ({ [SAME]: ev }));
    if (out && typeof out === "object" && !(SAME in out) && "drop" in out) return block(out.drop);
    const final = out?.[SAME];
    if (final && typeof final.text === "string" && final.text !== p.text && final.text.trim() !== "") return { decision: "replace", replacement: { text: final.text } };
    return pass;
  },
  "session.start": async () => { if (startRan) return pass; startRan = true; await runChain("session.start", {}, () => ({})); return pass; },
  "session.end": async () => { await runChain("session.end", { reason: "other" }, () => ({})); return pass; },
  "agent.before_start": async () => { session.turns++; await runChain("turn.start", {}, () => ({})); scheduleRedraw(); return pass; },
};

// ---- the virtual 'claude-code' module -----------------------------------------
const LOADER = `export async function resolve(s, c, n) { if (s === 'claude-code') return { url: 'reasonix-mod:claude-code', shortCircuit: true }; return n(s, c); }
export async function load(u, c, n) { if (u === 'reasonix-mod:claude-code') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
export const atom = (source, def) => ({ plugin: source.plugin, key: source.key, default: def });
export const read = ($, a) => $.state.get(a);
export const update = async ($, a, f) => $.state.set(a, f(await $.state.get(a)));
export const derive = (f) => f;
export const memberOf = (...x) => x;
`)} }; return n(u, c); }`;
registerLoader("data:text/javascript;base64," + Buffer.from(LOADER).toString("base64"), import.meta.url);

// ---- protocol ---------------------------------------------------------------
let initialized = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => { if (line.trim()) handle(JSON.parse(line)).catch((e) => diag("mod.crashed", String(e?.stack ?? e))); });
rl.on("close", () => process.exit(0));

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message, reason) => send({ jsonrpc: "2.0", id, error: { code, message, data: reason ? { reason } : undefined } });

async function handle(m) {
  if (m.id !== undefined && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new ModError("mod.host_error", m.error.message)) : p.resolve(m.result); } return; }
  switch (m.method) {
    case "extension/initialize": return init(m);
    case "extension/initialized": initialized = true; scheduleRedraw(); return;
    case "extension/intercept": {
      const h = intercepts[m.params.event];
      if (!h) return reply(m.id, pass);
      try { return reply(m.id, await h(m.params.payload ?? {})); } catch (e) { diag(e?.code ?? "mod.hook_threw", String(e?.message ?? e)); return reply(m.id, pass); }
    }
    case "extension/event": return;
    case "extension/ui/action": {
      const cmd = registeredCommands.get(m.params.actionId);
      if (cmd) {
        try {
          const out = await runChain("command.run", { name: cmd.name, args: m.params.args ?? {} }, async (ev) => cmd.run?.($, ev.args));
          const text = typeof out === "string" ? out : out?.text;
          return reply(m.id, { accepted: true, message: typeof text === "string" ? text.slice(0, 2000) : undefined });
        } catch (e) { return reply(m.id, { accepted: false, message: String(e?.message ?? e) }); }
      }
      const slot = Number(String(m.params.actionId).replace("press.", ""));
      try { await drawing[slot]?.({ surface: "desktop" }); } catch (e) { diag("mod.hook_threw", String(e)); }
      scheduleRedraw();
      return reply(m.id, { accepted: Boolean(drawing[slot]) });
    }
    case "extension/tool/call": {
      const t = registeredTools.get(m.params.name);
      if (!t) return fail(m.id, -32602, `no tool ${m.params.name}`, "invalid_params");
      try { const r = await (t.run ?? t.execute)($, m.params.arguments ?? {}); return reply(m.id, { content: typeof r === "string" ? r : JSON.stringify(r ?? "") }); }
      catch (e) { return reply(m.id, { content: String(e?.message ?? e), isError: true }); }
    }
    case "extension/shutdown": reply(m.id, { accepted: true }); setTimeout(() => process.exit(0), 20); return;
    default: if (m.id !== undefined) fail(m.id, -32601, `unknown method ${m.method}`, "unknown_method");
  }
}

async function init(m) {
  sessionCtx = { sessionId: m.params.session.sessionId, generation: m.params.session.generation };
  session.id = sessionCtx.sessionId; session.cwd = session.root = m.params.session.workspaceRoot;
  try {
    const mod = await import(pathToFileURL(MODULE).href);
    if (typeof mod.register !== "function" && typeof mod.default !== "function") throw new ModError("mod.no_register", "the module does not export register(on, options)");
    await (mod.register ?? mod.default)(on, CONFIG.options ?? {});
    // Tools and commands are registered in session.start; it runs once, here,
    // so the handshake can describe them and the host sends no second one.
    registering = true;
    try { await intercepts["session.start"](); } finally { registering = false; }
  } catch (e) {
    diag(e?.code ?? "mod.crashed", String(e?.message ?? e));
    return fail(m.id, -32000, String(e?.message ?? e), "activation_failed");
  }
  if (unserved.size) diag("mod.unsupported", `registered, never raised by this host: ${[...unserved].sort().join(", ")}`);
  reply(m.id, {
    protocolVersion: m.params.protocolVersion, name: PLUGIN_NAME, version: "0.0.0-mod", stateSchemaVersion: 0,
    subscriptions: Object.keys(intercepts).filter((p) => CONFIG.intercepts?.includes(p) ?? true),
    uiActions: [...Array.from({ length: MAX_BUTTONS }, (_, i) => ({ actionId: `press.${i}`, label: `press ${i}` })), ...[...registeredCommands.values()].map((c) => ({ actionId: c.name, label: c.description ?? c.name }))],
    tools: [...registeredTools.keys()],
    toolSpecs: [...registeredTools.values()].map((t) => ({ name: t.name, description: String(t.description ?? t.name), inputSchema: t.inputSchema ?? { type: "object" }, readOnly: Boolean(t.readOnly) })),
  });
}
