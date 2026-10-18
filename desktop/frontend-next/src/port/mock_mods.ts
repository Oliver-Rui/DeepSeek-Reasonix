import type { ModStatus } from "./boundary";

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
