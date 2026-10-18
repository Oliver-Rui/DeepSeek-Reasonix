import type { ModStatus } from "./boundary";
import type { ModPreview, PluginPlan } from "./plugin";

const RUNTIME = { kind: "electron", path: "/Applications/Reasonix Studio.app/Contents/MacOS/Reasonix Studio", version: "v22.12.0" };

/** Four installed mods in the states a person can meet: the list is the same
 *  with the switch off, but then nothing runs and each says why. */
export function mockMods(enabled: boolean): ModStatus[] {
  const names = ["statusline-clock", "git-guard", "prompt-tweaks", "fancy-notes"];
  if (!enabled) return names.map((plugin) => ({ plugin, state: "inactive" as const, code: "mod.switch_off", restarts: 0 }));
  return [
    { plugin: names[0], state: "running", restarts: 0, runtime: RUNTIME, events: ["session.start", "turn.complete"], unserved: [] },
    { plugin: names[1], state: "disabled", code: "mod.hook_timeout", restarts: 3, runtime: RUNTIME, events: ["tool.check", "tool.after"], unserved: ["tool.rewrite"] },
    { plugin: names[2], state: "restarting", code: "mod.crashed", restarts: 1, runtime: RUNTIME, events: ["prompt.submit"], unserved: [] },
    { plugin: names[3], state: "inactive", code: "mod.runtime_missing", restarts: 0, events: ["turn.complete"], unserved: [] },
  ];
}

export const MOCK_MOD_PREVIEW: ModPreview = {
  plugin: "git-guard", module: "hooks/index.js", sha256: "9f2c41b07ad35e8c61f0aa42d9be3377c0e1145f8a6d2b9c4e7710d3a5b8c6e2", listed: true,
  events: [{ name: "tool.check" }, { name: "tool.after" }, { name: "turn.complete" }, { name: "x", dynamic: true }],
  api: [{ namespace: "process", method: "run" }, { namespace: "fs", method: "readFile" }, { namespace: "ui", method: "toast" }],
  imports: [{ spec: "./lib/rules.js", kind: "static" }, { spec: "minimatch", kind: "require" }],
  findings: [{ kind: "computed_member" }],
  unserved: ["tool.rewrite"],
};

/** The plan a source naming a mod gets: one package whose action carries the
 *  preview of its hooks module. */
export function mockModPlan(source: string): PluginPlan {
  return {
    ok: true, status: "planned", applied: false, source, planId: "high:sha256:mockmod",
    actions: [{
      kind: "plugin", action: "install_plugin_package", status: "planned", riskLevel: "high", name: "git-guard", version: "1.2.0", source,
      target: "~/.reasonix/plugins/git-guard", manifestKind: "claude-code", skills: [], skillCount: 0, commandCount: 0, hookCount: 0,
      riskReasons: ["FULL TRUST: ships a Claude Code mod whose code runs on this machine"], mod: MOCK_MOD_PREVIEW,
    }],
    next: "Review the plan, then install.",
  };
}
