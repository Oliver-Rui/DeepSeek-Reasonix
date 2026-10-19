// @ts-expect-error Node 22+ provides node:sqlite; Worker production code does not import it.
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Test code uses Node to inspect the repository.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import { installHash, installToken } from "./feedback_crypto";
import { BOARD_CACHE_DEFAULT_SECONDS, BOARD_CACHE_MAX_SECONDS, boardCacheSeconds } from "./feedback_board";
import { checkBoardName, RESERVED_BOARD_NAMES } from "./feedback_board_names";
import { d1 } from "./feedback_testkit";
import { handleFeedbackRoute } from "./feedback_routes";
import feedbackMigrationSQL from "../migrate-feedback.sql?raw";
import triageMigrationSQL from "../migrate-feedback-triage.sql?raw";
import adoptionsMigrationSQL from "../migrate-feedback-adoptions.sql?raw";
import linksMigrationSQL from "../migrate-feedback-account-links.sql?raw";
import boardMigrationSQL from "../migrate-feedback-board.sql?raw";
import boardRollbackSQL from "../migrate-feedback-board.down.sql?raw";

const ADMIN = "admin-secret";
const TOKEN_SECRET = "token-secret";
const ACCOUNT_SECRET = "account-secret";
const EMAIL = "ada.private@example.com";
const enc = new TextEncoder();

let db: DatabaseSync;
let env: Env;
let item = 0;

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))));
}
async function assertion(sub: string | number): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({ aud: "feedback", exp: Math.floor(Date.now() / 1000) + 300, sub: String(sub) })));
  return `v1.${payload}.${await mac(ACCOUNT_SECRET, `feedback-assertion:${payload}`)}`;
}
const installId = (n: number) => `install-${String(n).padStart(8, "0")}-aaaaaaaa`;
const proof = async (n: number) => ({ "x-install-id": installId(n), "x-install-token": await installToken(TOKEN_SECRET, installId(n)) });
const acct = async (sub: string | number) => ({ "x-account-assertion": await assertion(sub) });
const hashOf = (n: number) => installHash(TOKEN_SECRET, installId(n));

const call = (path: string, init: RequestInit = {}) => handleFeedbackRoute(new Request(`https://crash.test${path}`, init), env) as Promise<Response | null>;
const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  (await call(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })) as Response;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const rows = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as any[];

const link = async (n: number, sub: number) => send("POST", "/v1/feedback/link", { ...(await proof(n)), ...(await acct(sub)) });
const unlink = async (n: number, sub: number) => send("DELETE", "/v1/feedback/link", { ...(await proof(n)), ...(await acct(sub)) });
const optIn = async (sub: number, displayName: unknown) => send("PUT", "/v1/feedback/board/optin", await acct(sub), { displayName });
const optOut = async (sub: number) => send("DELETE", "/v1/feedback/board/optin", await acct(sub));
const mine = async (sub: number) => send("GET", "/v1/feedback/board/me", await acct(sub));
const board = (query = "") => send("GET", `/v1/feedback/board${query}`, {});
const names = async (query = "") => ((await (await board(query)).json()) as { entries: { displayName: string }[] }).entries.map((e) => e.displayName);
const admin = { authorization: `Bearer ${ADMIN}` };

async function adopt(n: number, itemKey: string, version: string, over: { tombstoned?: boolean; at?: string } = {}) {
  const hash = await hashOf(n);
  db.prepare("INSERT INTO feedback_adoptions (install_hash, item_key, receipt, version, adopted_at, tombstoned_at) VALUES (?,?,?,?,?,?)")
    .run(hash, itemKey, `FB-${String(++item).padStart(4, "0")}-AAAA`, version, over.at ?? `2026-10-${String(10 + item).padStart(2, "0")}T00:00:00.000Z`, over.tombstoned ? "2026-10-30T00:00:00.000Z" : null);
}

async function person(n: number, sub: number, name: string, credits: [string, string][]) {
  expect((await link(n, sub)).status).toBe(201);
  for (const [key, version] of credits) await adopt(n, key, version);
  expect((await optIn(sub, name)).status).toBe(200);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const sql of [feedbackMigrationSQL, triageMigrationSQL, adoptionsMigrationSQL, linksMigrationSQL, boardMigrationSQL]) db.exec(sql);
  item = 0;
  env = {
    DB: d1(db),
    FEEDBACK_LIMITER: { limit: async () => ({ success: true }) },
    FEEDBACK_TOKEN_SECRET: TOKEN_SECRET,
    FEEDBACK_ADMIN_TOKEN: ADMIN,
    FEEDBACK_ENABLED: "true",
    FEEDBACK_ACCOUNT_LINK: "true",
    FEEDBACK_ACCOUNT_SECRET: ACCOUNT_SECRET,
    FEEDBACK_BOARD: "true",
  } as unknown as Env;
});

describe("the flag", () => {
  it("leaves every board route absent unless FEEDBACK_BOARD is true and linking is on", async () => {
    for (const patch of [{ FEEDBACK_BOARD: "false" }, { FEEDBACK_BOARD: undefined }, { FEEDBACK_ACCOUNT_LINK: "false" }]) {
      env = { ...env, ...patch } as Env;
      expect(await call("/v1/feedback/board")).toBeNull();
      expect(await call("/v1/feedback/board/optin", { method: "PUT" })).toBeNull();
      expect(await call("/v1/admin/feedback/board", { headers: admin })).not.toBeInstanceOf(Response);
    }
  });
});

describe("display names", () => {
  it.each([
    ["an email", "ada@example.com"],
    ["a link", "ada.example.com"],
    ["a scheme", "https://x"],
    ["too short", "a"],
    ["too long", "x".repeat(31)],
    ["empty", "   "],
    ["control characters", "ada\u0000b"],
    ["not a string", 42],
  ])("refuses %s as invalid", (_n, name) => {
    expect(checkBoardName(name)).toEqual({ ok: false, reason: "invalid" });
  });

  it.each(["Reasonix", "ＲＥＡＳＯＮＩＸ", "re-a-son-ix", "esengine", "Official Admin", "admin_", "reasonix team", "the-maintainer", "ESENGINE dev"])("refuses the lookalike %s as reserved", (name) => {
    expect(checkBoardName(name)).toEqual({ ok: false, reason: "reserved" });
  });

  it.each([
    ["Cyrillic е and о spelling esengine", "\u0435s\u0435ngin\u0435"],
    ["Cyrillic о and а spelling reasonix", "re\u0430s\u043enix"],
    ["Cyrillic а spelling admin", "\u0430dmin"],
    ["Greek ο spelling reasonix", "reasonix".replace("o", "\u03bf")],
    ["Cyrillic and Greek together", "\u0430\u03b1 team"],
    ["Latin with one Cyrillic letter", "Ada \u0412"],
  ])("refuses a name that mixes scripts: %s", (_n, name) => {
    expect(checkBoardName(name)).toEqual({ ok: false, reason: "invalid" });
  });

  it.each(["Иван Петров", "Αλέξανδρος", "张三 2", "Ada 42", "Zoë 3"])("allows a name written in one script: %s", (name) => {
    expect(checkBoardName(name)).toMatchObject({ ok: true });
  });

  it("takes the reserved list from one declared table", () => {
    for (const reserved of RESERVED_BOARD_NAMES) expect(checkBoardName(reserved.toUpperCase()).ok).toBe(false);
  });

  it.each(["Ada Lovelace", "张三", "grace_h", "Linus-T", "Zoë"])("accepts %s", (name) => {
    expect(checkBoardName(name)).toMatchObject({ ok: true });
  });

  it("answers the refusals with their own codes", async () => {
    await link(1, 42);
    expect(await code(await optIn(42, "ada@example.com"))).toBe("feedback.board_name_invalid");
    expect(await code(await optIn(42, "Reasonix"))).toBe("feedback.board_name_reserved");
    expect(rows("SELECT * FROM feedback_board_optin")).toHaveLength(0);
  });
});

describe("opting in", () => {
  it("needs the account assertion and a linked install", async () => {
    expect((await send("PUT", "/v1/feedback/board/optin", {}, { displayName: "Ada" })).status).toBe(401);
    expect(await code(await optIn(42, "Ada"))).toBe("feedback.board_no_link");
    await link(1, 42);
    expect((await optIn(42, "Ada")).status).toBe(200);
    expect(await (await mine(42)).json()).toEqual({ listed: true, displayName: "Ada", delisted: false });
  });

  it("keeps a name to one person, case and spacing aside, and lets its holder rename", async () => {
    await link(1, 42);
    await link(2, 43);
    expect((await optIn(42, "Ada Lovelace")).status).toBe(200);
    expect(await code(await optIn(43, "ada  lovelace"))).toBe("feedback.board_name_taken");
    expect(await code(await optIn(43, "ADA-LOVELACE"))).toBe("feedback.board_name_taken");
    expect((await optIn(42, "Ada L")).status).toBe(200);
    expect((await optIn(43, "Ada Lovelace")).status).toBe(200);
    expect(rows("SELECT display_name FROM feedback_board_optin ORDER BY display_name").map((r) => r.display_name)).toEqual(["Ada L", "Ada Lovelace"]);
  });

  it("records typed events for linking, opting in and opting out, with no hash in them", async () => {
    await link(1, 42);
    await optIn(42, "Ada");
    await optOut(42);
    await unlink(1, 42);
    const events = rows("SELECT action, detail FROM feedback_audit ORDER BY id");
    expect(events.map((e) => e.action)).toEqual(["board.link_confirmed", "board.opted_in", "board.opted_out", "board.unlinked"]);
    const text = JSON.stringify(events);
    for (const secret of [await hashOf(1), installId(1), "1b195c7c60af4a567bb88df61db76a2317ad78174039b7ea2643bbaf92594a4f"]) expect(text).not.toContain(secret);
  });
});

describe("credits", () => {
  it("counts only untombstoned adoptions, once per item per account, and not for revoked or blocked installs", async () => {
    await link(1, 42);
    await link(2, 42);
    await adopt(1, "issue:100", "v2.1.0");
    await adopt(2, "issue:100", "v2.1.0");
    await adopt(1, "issue:101", "v2.2.0");
    await adopt(1, "issue:102", "v2.2.0", { tombstoned: true });
    await optIn(42, "Ada");
    await link(3, 43);
    await adopt(3, "issue:200", "v2.1.0");
    await optIn(43, "Grace");
    await link(4, 44);
    await adopt(4, "issue:300", "v2.1.0");
    await optIn(44, "Linus");
    await link(5, 45);
    await adopt(5, "issue:400", "v2.1.0");
    await optIn(45, "Margaret");
    db.prepare("INSERT INTO feedback_level_state (install_hash, high_water_count, revoked_at, updated_at) VALUES (?, 0, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')").run(await hashOf(4));
    db.prepare("INSERT INTO feedback_blocks (target, reason, created_at, expires_at) VALUES (?, 'abuse', '2026-10-20T00:00:00.000Z', NULL)").run(`install:${await hashOf(5)}`);
    const body = (await (await board()).json()) as { entries: { displayName: string; credits: number }[] };
    expect(body.entries.map((e) => [e.displayName, e.credits])).toEqual([["Ada", 2], ["Grace", 1]]);
  });

  it("ranks a release with ties sharing a rank and breaking order by the earliest credit", async () => {
    await person(1, 41, "Ada", [["issue:1", "v2.1.0"], ["issue:2", "v2.1.0"]]);
    await person(2, 42, "Grace", [["issue:3", "v2.1.0"]]);
    await person(3, 43, "Linus", [["issue:4", "v2.1.0"]]);
    await person(4, 44, "Margaret", [["issue:5", "v2.0.0"]]);
    const view = (await (await board("?release=v2.1.0")).json()) as { view: string; release: string; entries: { displayName: string; rank: number; credits: number }[] };
    expect(view.view).toBe("release");
    expect(view.release).toBe("v2.1.0");
    expect(view.entries.map((e) => [e.displayName, e.credits, e.rank])).toEqual([["Ada", 2, 1], ["Grace", 1, 2], ["Linus", 1, 2]]);
  });

  it("lists the all-time view alphabetically without ranks, newest release first", async () => {
    await person(1, 41, "Zed", [["issue:1", "v2.9.0"], ["issue:2", "v2.10.0"]]);
    await person(2, 42, "Ada", [["issue:3", "v2.1.0"]]);
    const all = (await (await board()).json()) as { entries: { displayName: string; rank: number | null; releases: { version: string; count: number }[] }[] };
    expect(all.entries.map((e) => [e.displayName, e.rank])).toEqual([["Ada", null], ["Zed", null]]);
    expect(all.entries[1].releases).toEqual([{ version: "v2.10.0", count: 1 }, { version: "v2.9.0", count: 1 }]);
  });

  it("refuses a release that is not a concrete version", async () => {
    expect((await board("?release=latest")).status).toBe(400);
    expect((await board("?release=v2.1")).status).toBe(400);
  });
});

describe("what a response can carry", () => {
  it("is built from the whitelist, field by field, and holds no email, hash or install id", async () => {
    await link(1, 42);
    await adopt(1, "issue:1", "v2.1.0");
    await optIn(42, "Ada");
    db.prepare("UPDATE feedback_adoptions SET receipt = 'FB-SECR-ET00'").run();
    db.prepare("INSERT INTO feedback (idempotency_key, install_hash, receipt, category, body, display_name, contact, status, created_at, updated_at) VALUES ('key-00000001', ?, 'FB-SECR-ET01', 'bug', 'b', 'Ada', ?, 'recorded', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')").run(await hashOf(1), EMAIL);
    for (const query of ["", "?release=v2.1.0"]) {
      const res = await board(query);
      const body = (await res.json()) as { view: string; release: string | null; entries: Record<string, unknown>[] };
      expect(Object.keys(body).sort()).toEqual(["entries", "release", "view"]);
      for (const entry of body.entries) {
        expect(Object.keys(entry).sort()).toEqual(["credits", "displayName", "rank", "releases"]);
        for (const r of entry.releases as Record<string, unknown>[]) expect(Object.keys(r).sort()).toEqual(["count", "version"]);
      }
      const text = JSON.stringify(body);
      for (const secret of [EMAIL, await hashOf(1), installId(1), (await proof(1))["x-install-token"], "1b195c7c60af4a567bb88df61db76a2317ad78174039b7ea2643bbaf92594a4f", "FB-SECR", "issue:1"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("leaving", () => {
  const listed = async () => (await names()).includes("Ada");

  it("drops a person on the next uncached read after opting out, unlinking the last install, or deleting the account", async () => {
    await person(1, 42, "Ada", [["issue:1", "v2.1.0"]]);
    expect(await listed()).toBe(true);
    await optOut(42);
    expect(await listed()).toBe(false);

    await optIn(42, "Ada");
    expect(await listed()).toBe(true);
    await unlink(1, 42);
    expect(await listed()).toBe(false);
    expect(rows("SELECT * FROM feedback_board_optin")).toHaveLength(0);

    await link(1, 42);
    await optIn(42, "Ada");
    expect(await listed()).toBe(true);
    const body = JSON.stringify({ sub: "42" });
    const res = await call("/v1/feedback/account/erase", { method: "POST", headers: { "x-erase-signature": await mac(ACCOUNT_SECRET, `feedback-account-erase:${body}`) }, body });
    expect(res!.status).toBe(200);
    expect(await listed()).toBe(false);
    expect(rows("SELECT * FROM feedback_board_optin")).toHaveLength(0);
  });

  it("keeps the entry while another install of the account stays linked", async () => {
    await person(1, 42, "Ada", [["issue:1", "v2.1.0"]]);
    await link(2, 42);
    await adopt(2, "issue:9", "v2.1.0");
    await unlink(1, 42);
    expect(rows("SELECT * FROM feedback_board_optin")).toHaveLength(1);
    expect(await listed()).toBe(true);
  });

  it("lets browsers and the CDN keep a response for the named setting at most, never stale", async () => {
    const res = await board();
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toBe(`public, max-age=${BOARD_CACHE_DEFAULT_SECONDS}, s-maxage=${BOARD_CACHE_DEFAULT_SECONDS}`);
    expect(cache).not.toMatch(/stale|immutable/);
    expect(BOARD_CACHE_DEFAULT_SECONDS).toBeLessThanOrEqual(300);
  });

  it("clamps the cache window and falls back to the default for nonsense", () => {
    const at = (v: string | undefined) => boardCacheSeconds({ FEEDBACK_BOARD_CACHE_SECONDS: v } as Env);
    expect(at("60")).toBe(60);
    expect(at("86400")).toBe(BOARD_CACHE_MAX_SECONDS);
    expect(at("-5")).toBe(BOARD_CACHE_DEFAULT_SECONDS);
    expect(at("abc")).toBe(BOARD_CACHE_DEFAULT_SECONDS);
    expect(at(undefined)).toBe(BOARD_CACHE_DEFAULT_SECONDS);
  });

  it("is not cached at all when the window is zero", async () => {
    env = { ...env, FEEDBACK_BOARD_CACHE_SECONDS: "0" } as Env;
    expect((await board()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("delisting", () => {
  it("is for the admin only, removes the entry, blocks a return, and can be undone", async () => {
    await person(1, 42, "Ada", [["issue:1", "v2.1.0"]]);
    expect((await send("POST", "/v1/admin/feedback/board/delist", {}, { displayName: "Ada" })).status).toBe(401);
    expect((await send("POST", "/v1/admin/feedback/board/delist", admin, { displayName: "Nobody" })).status).toBe(404);
    expect((await send("POST", "/v1/admin/feedback/board/delist", admin, { displayName: "ada" })).status).toBe(200);
    expect(await names()).toEqual([]);
    expect(await (await mine(42)).json()).toEqual({ listed: false, displayName: null, delisted: true });
    expect(await code(await optIn(42, "Ada Again"))).toBe("feedback.board_delisted");
    expect(rows("SELECT action, detail FROM feedback_audit WHERE action = 'board.delisted'")).toEqual([{ action: "board.delisted", detail: "name:ada" }]);

    expect((await send("DELETE", "/v1/admin/feedback/board/delist", admin, { displayName: "Ada" })).status).toBe(200);
    expect((await optIn(42, "Ada")).status).toBe(200);
    expect(await names()).toEqual(["Ada"]);
    expect(rows("SELECT action FROM feedback_audit WHERE action = 'board.restored'")).toHaveLength(1);
  });

  it("lists the names the admin can act on without any account data", async () => {
    await person(1, 42, "Ada", [["issue:1", "v2.1.0"]]);
    const res = await send("GET", "/v1/admin/feedback/board", admin);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Ada");
    expect(text).not.toContain(await hashOf(1));
  });
});

describe("cross-origin reads", () => {
  it("lets any origin read the public board, without credentials, and refusals of that read too", async () => {
    const ok = await board();
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const bad = await board("?release=latest");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("*");
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("gives no other route the header: own state, opt-in, opt-out, the admin routes, the link routes", async () => {
    await link(1, 42);
    const answers: Response[] = [
      await mine(42),
      await optIn(42, "Ada"),
      await optIn(42, "Reasonix"),
      await optOut(42),
      await send("GET", "/v1/admin/feedback/board", admin),
      await send("POST", "/v1/admin/feedback/board/delist", admin, { displayName: "Nobody" }),
      await send("DELETE", "/v1/admin/feedback/board/delist", admin, { displayName: "Nobody" }),
      await send("GET", "/v1/admin/feedback/board", {}),
      await send("GET", "/v1/feedback/link", { ...(await proof(1)), ...(await acct(42)) }),
      await send("GET", "/v1/feedback/account/mine", await acct(42)),
      await send("POST", "/v1/feedback/board", {}),
    ];
    for (const res of answers) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("migration", () => {
  it("is re-runnable and rolls back to nothing", () => {
    db.exec(boardMigrationSQL);
    expect(rows("SELECT name FROM sqlite_master WHERE name LIKE 'feedback_board%' ORDER BY name").map((r) => r.name)).toEqual(["feedback_board_delisted", "feedback_board_optin", "sqlite_autoindex_feedback_board_delisted_1", "sqlite_autoindex_feedback_board_optin_1", "sqlite_autoindex_feedback_board_optin_2"].filter((n) => !n.startsWith("sqlite_")));
    db.exec(boardRollbackSQL);
    expect(rows("SELECT name FROM sqlite_master WHERE name LIKE 'feedback_board%'")).toEqual([]);
  });
});

describe("deploy contract", () => {
  it("applies and verifies the board tables after the link table and before the Worker deploys", () => {
    const workflow = readFileSync("../../.github/workflows/deploy-crash-worker.yml", "utf8") as string;
    const step = workflow.indexOf("Apply and verify feedback contribution board D1 migration");
    expect(step).toBeGreaterThan(workflow.indexOf("Apply and verify feedback account link D1 migration"));
    expect(step).toBeLessThan(workflow.indexOf("npx wrangler deploy"));
    const body = workflow.slice(step, workflow.indexOf("- name: Apply Studio telemetry schema"));
    expect(body).toContain("--file=migrate-feedback-board.sql");
    for (const name of ["feedback_board_optin", "feedback_board_delisted"]) expect(body).toContain(name);
    expect(body).toContain("missing $name after migration");
  });

  it("ships the board on, as the owner decided for production", () => {
    const toml = readFileSync("wrangler.toml", "utf8") as string;
    expect(toml).toMatch(/^FEEDBACK_BOARD = "true"$/m);
    expect(toml).toMatch(/^FEEDBACK_BOARD_CACHE_SECONDS = "300"$/m);
  });
});
