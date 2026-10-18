// Names a maintainer or the project could be mistaken for. A listed name may not equal,
// start with or end with one of these once case, width and punctuation are folded away.
export const RESERVED_BOARD_NAMES: readonly string[] = [
  "esengine",
  "reasonix",
  "deepseek",
  "admin",
  "administrator",
  "maintainer",
  "moderator",
  "official",
  "staff",
  "support",
  "system",
  "root",
];

export const BOARD_NAME_MIN = 2;
export const BOARD_NAME_MAX = 30;

// Letters, digits, spaces, underscore and hyphen only. No "@" and no ".", so an email
// address or a link cannot be spelled at all.
const NAME_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

// A name is read in one script: Latin, Cyrillic and Greek letters share lookalikes, so a
// name that uses more than one of them could spell a reserved name that no fold equates.
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

const mixesScripts = (name: string): boolean => SCRIPTS.filter((script) => script.test(name)).length > 1;

export const boardNameKey = (raw: string): string => raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export type BoardName = { ok: true; name: string; key: string } | { ok: false; reason: "invalid" | "reserved" };

export function checkBoardName(raw: unknown): BoardName {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const length = [...name].length;
  if (length < BOARD_NAME_MIN || length > BOARD_NAME_MAX || !NAME_SHAPE.test(name) || mixesScripts(name)) return { ok: false, reason: "invalid" };
  const key = boardNameKey(name);
  if (key === "") return { ok: false, reason: "invalid" };
  const taken = RESERVED_BOARD_NAMES.some((r) => key === r || key.startsWith(r) || key.endsWith(r));
  return taken ? { ok: false, reason: "reserved" } : { ok: true, name, key };
}
