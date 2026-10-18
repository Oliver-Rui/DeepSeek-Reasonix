import type { Env } from "./env";
import { accountLinkEnabled, verifyAssertion } from "./feedback_account";
import { requireAdmin } from "./feedback_auth";
import { audit } from "./feedback_blocks";
import { readCappedText } from "./feedback_body";
import { ipPrefix } from "./feedback_crypto";
import { jsonResponse, refuse, windowDetails } from "./feedback_http";
import { boardNameKey, checkBoardName } from "./feedback_board_names";
import { take } from "./feedback_quota";
import { CONCRETE_VERSION } from "./feedback_types";

export const BOARD_CACHE_DEFAULT_SECONDS = 300;
export const BOARD_CACHE_MAX_SECONDS = 900;
const MAX_ENTRIES = 200;
const BODY_BYTES = 1024;
const WRITES_PER_ACCOUNT_DAILY = 20;
const NOT_ALLOWED = () => refuse("feedback.method_not_allowed", "method not allowed");

export const boardEnabled = (env: Env): boolean => env.FEEDBACK_BOARD === "true" && accountLinkEnabled(env);

export function boardCacheSeconds(env: Env): number {
  const n = Number(env.FEEDBACK_BOARD_CACHE_SECONDS);
  if (env.FEEDBACK_BOARD_CACHE_SECONDS === undefined || !Number.isInteger(n) || n < 0) return BOARD_CACHE_DEFAULT_SECONDS;
  return Math.min(n, BOARD_CACHE_MAX_SECONDS);
}

// What the next account-keyed read stops showing: unlinking the last install, or deleting
// the account, removes the entry with the link.
export async function dropBoardEntry(env: Env, accountHash: string, whenUnlinked: boolean): Promise<void> {
  if (whenUnlinked) {
    await env.DB.prepare(
      "DELETE FROM feedback_board_optin WHERE account_hash = ? AND NOT EXISTS (SELECT 1 FROM feedback_account_links WHERE account_hash = ?)",
    ).bind(accountHash, accountHash).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feedback_board_optin WHERE account_hash = ?").bind(accountHash),
    env.DB.prepare("DELETE FROM feedback_board_delisted WHERE account_hash = ?").bind(accountHash),
  ]);
}

async function throttle(request: Request, env: Env, bucket: string, now: Date): Promise<Response | null> {
  if (!env.FEEDBACK_LIMITER) return refuse("feedback.account_unavailable", "the board is unavailable");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.FEEDBACK_LIMITER.limit({ key: `board:${ipPrefix(ip)}` })).success) {
    return refuse("feedback.rate_limited", "too many requests", windowDetails("ip_hourly", now));
  }
  if (bucket === "") return null;
  if (!(await take(env, bucket, now.toISOString().slice(0, 10), WRITES_PER_ACCOUNT_DAILY))) {
    return refuse("feedback.rate_limited", "too many requests", windowDetails("link_daily", now));
  }
  return null;
}

interface Credit {
  name: string;
  item: string;
  version: string;
  at: string;
}

// One row per (account, item): the same adopted item reached through two linked
// installs counts once. Revoked and blocked installs, tombstoned adoptions and
// delisted accounts contribute nothing.
async function credits(env: Env, now: Date): Promise<Credit[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.display_name AS name, a.item_key AS item, a.version AS version, MIN(a.adopted_at) AS at
       FROM feedback_board_optin o
       JOIN feedback_account_links l ON l.account_hash = o.account_hash
       JOIN feedback_adoptions a ON a.install_hash = l.install_hash AND a.tombstoned_at IS NULL
       LEFT JOIN feedback_level_state s ON s.install_hash = l.install_hash
      WHERE s.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM feedback_board_delisted d WHERE d.account_hash = o.account_hash)
        AND NOT EXISTS (SELECT 1 FROM feedback_blocks b WHERE b.target = 'install:' || l.install_hash AND (b.expires_at IS NULL OR b.expires_at > ?))
      GROUP BY o.account_hash, a.item_key`,
  ).bind(now.toISOString()).all<Credit>();
  return results;
}

const byVersionDesc = (a: string, b: string) => {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};

interface Entry {
  displayName: string;
  credits: number;
  rank: number | null;
  releases: { version: string; count: number }[];
}

// Entries are built field by field from the whitelist; nothing is copied from a row.
export function buildBoard(rows: Credit[], release: string | null): Entry[] {
  const people = new Map<string, { name: string; first: string; perVersion: Map<string, number> }>();
  for (const r of rows) {
    if (release !== null && r.version !== release) continue;
    const person = people.get(r.name) ?? { name: r.name, first: r.at, perVersion: new Map<string, number>() };
    if (r.at < person.first) person.first = r.at;
    person.perVersion.set(r.version, (person.perVersion.get(r.version) ?? 0) + 1);
    people.set(r.name, person);
  }
  const list = [...people.values()].map((p) => ({
    first: p.first,
    entry: {
      displayName: p.name,
      credits: [...p.perVersion.values()].reduce((sum, n) => sum + n, 0),
      rank: null as number | null,
      releases: [...p.perVersion.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => byVersionDesc(a.version, b.version)),
    },
  }));
  if (release === null) return list.map((p) => p.entry).sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, MAX_ENTRIES);
  list.sort((a, b) => b.entry.credits - a.entry.credits || a.first.localeCompare(b.first) || a.entry.displayName.localeCompare(b.entry.displayName));
  let rank = 0;
  list.forEach((p, i) => {
    if (i === 0 || p.entry.credits !== list[i - 1].entry.credits) rank = i + 1;
    p.entry.rank = rank;
  });
  return list.map((p) => p.entry).slice(0, MAX_ENTRIES);
}

async function boardBody(request: Request, env: Env, url: URL): Promise<Response> {
  const now = new Date();
  const limited = await throttle(request, env, "", now);
  if (limited) return limited;
  const param = url.searchParams.get("release") ?? "all";
  if (param !== "all" && !CONCRETE_VERSION.test(param)) return refuse("feedback.invalid", "release must be all or a version like v2.1.0");
  const release = param === "all" ? null : param;
  const entries = buildBoard(await credits(env, now), release);
  const seconds = boardCacheSeconds(env);
  const cache = seconds === 0 ? "no-store" : `public, max-age=${seconds}, s-maxage=${seconds}`;
  return jsonResponse({ view: release === null ? "all" : "release", release, entries }, 200, { "cache-control": cache });
}

// The public read is the one answer a page on another origin may read: a plain GET
// with no credentials. Nothing else in this module, nor any other route, carries
// the header.
async function readBoard(request: Request, env: Env, url: URL): Promise<Response> {
  const res = await boardBody(request, env, url);
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(res.body, { status: res.status, headers });
}

async function callerAccount(request: Request, env: Env, writes: boolean): Promise<{ accountHash: string; now: Date } | Response> {
  const now = new Date();
  const account = await verifyAssertion(env, request.headers.get("x-account-assertion") ?? "", now);
  if (account instanceof Response) return account;
  const limited = await throttle(request, env, writes ? `bw:${account.accountHash}` : "", now);
  return limited ?? { accountHash: account.accountHash, now };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readCappedText(request, BODY_BYTES);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function myState(request: Request, env: Env): Promise<Response> {
  const caller = await callerAccount(request, env, false);
  if (caller instanceof Response) return caller;
  const row = await env.DB.prepare("SELECT display_name FROM feedback_board_optin WHERE account_hash = ?").bind(caller.accountHash).first<{ display_name: string }>();
  const delisted = await env.DB.prepare("SELECT 1 AS x FROM feedback_board_delisted WHERE account_hash = ?").bind(caller.accountHash).first();
  return jsonResponse({ listed: row !== null && delisted === null, displayName: row?.display_name ?? null, delisted: delisted !== null });
}

async function optIn(request: Request, env: Env): Promise<Response> {
  const caller = await callerAccount(request, env, true);
  if (caller instanceof Response) return caller;
  const body = await readJson(request);
  const checked = checkBoardName(body?.displayName);
  if (!checked.ok) {
    return checked.reason === "reserved"
      ? refuse("feedback.board_name_reserved", "this name is reserved")
      : refuse("feedback.board_name_invalid", "a display name is 2 to 30 letters, digits, spaces, underscores or hyphens");
  }
  if (await env.DB.prepare("SELECT 1 AS x FROM feedback_board_delisted WHERE account_hash = ?").bind(caller.accountHash).first()) {
    return refuse("feedback.board_delisted", "this account was removed from the board");
  }
  if (!(await env.DB.prepare("SELECT 1 AS x FROM feedback_account_links WHERE account_hash = ? LIMIT 1").bind(caller.accountHash).first())) {
    return refuse("feedback.board_no_link", "link an install to this account first");
  }
  const insert = () => env.DB.prepare(
    `INSERT INTO feedback_board_optin (account_hash, display_name, name_key, opted_in_at)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM feedback_board_optin WHERE name_key = ? AND account_hash <> ?)
     ON CONFLICT (account_hash) DO UPDATE SET display_name = excluded.display_name, name_key = excluded.name_key`,
  ).bind(caller.accountHash, checked.name, checked.key, caller.now.toISOString(), checked.key, caller.accountHash).run();
  const nameHeldByAnother = () =>
    env.DB.prepare("SELECT 1 AS x FROM feedback_board_optin WHERE name_key = ? AND account_hash <> ?").bind(checked.key, caller.accountHash).first();
  let changes = 0;
  try {
    changes = (await insert()).meta?.changes ?? 0;
  } catch (err) {
    // A concurrent claim of the same name loses at the unique index; the stored state, not the
    // error, says whether that is what happened.
    if (!(await nameHeldByAnother())) throw err;
  }
  if (changes === 0) return refuse("feedback.board_name_taken", "another person already uses this name");
  await audit(env, "board.opted_in", `name:${checked.key}`);
  return jsonResponse({ listed: true, displayName: checked.name });
}

async function optOut(request: Request, env: Env): Promise<Response> {
  const caller = await callerAccount(request, env, true);
  if (caller instanceof Response) return caller;
  const res = await env.DB.prepare("DELETE FROM feedback_board_optin WHERE account_hash = ?").bind(caller.accountHash).run();
  if ((res.meta?.changes ?? 0) > 0) await audit(env, "board.opted_out", "account");
  return jsonResponse({ listed: false });
}

async function delist(request: Request, env: Env, restore: boolean): Promise<Response> {
  const body = await readJson(request);
  const key = typeof body?.displayName === "string" ? boardNameKey(body.displayName) : "";
  if (key === "") return refuse("feedback.invalid", "displayName is required");
  if (restore) {
    const res = await env.DB.prepare("DELETE FROM feedback_board_delisted WHERE name_key = ?").bind(key).run();
    if ((res.meta?.changes ?? 0) === 0) return refuse("feedback.not_found", "no delisted entry with this name");
    await audit(env, "board.restored", `name:${key}`);
    return jsonResponse({ restored: true });
  }
  const row = await env.DB.prepare("SELECT account_hash FROM feedback_board_optin WHERE name_key = ?").bind(key).first<{ account_hash: string }>();
  if (!row) return refuse("feedback.not_found", "no listed entry with this name");
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO feedback_board_delisted (account_hash, name_key, delisted_at) VALUES (?, ?, ?)").bind(row.account_hash, key, new Date().toISOString()),
    env.DB.prepare("DELETE FROM feedback_board_optin WHERE account_hash = ?").bind(row.account_hash),
  ]);
  await audit(env, "board.delisted", `name:${key}`);
  return jsonResponse({ delisted: true });
}

async function adminList(env: Env): Promise<Response> {
  const listed = await env.DB.prepare("SELECT display_name, opted_in_at FROM feedback_board_optin ORDER BY opted_in_at").all<{ display_name: string; opted_in_at: string }>();
  const gone = await env.DB.prepare("SELECT name_key, delisted_at FROM feedback_board_delisted ORDER BY delisted_at").all<{ name_key: string; delisted_at: string }>();
  return jsonResponse({
    listed: listed.results.map((r) => ({ displayName: r.display_name, optedInAt: r.opted_in_at })),
    delisted: gone.results.map((r) => ({ nameKey: r.name_key, delistedAt: r.delisted_at })),
  });
}

export async function handleBoardRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!boardEnabled(env)) return null;
  const method = request.method;
  if (path === "/v1/feedback/board") return method === "GET" ? readBoard(request, env, new URL(request.url)) : NOT_ALLOWED();
  if (path === "/v1/feedback/board/me") return method === "GET" ? myState(request, env) : NOT_ALLOWED();
  if (path === "/v1/feedback/board/optin") {
    if (method === "PUT") return optIn(request, env);
    return method === "DELETE" ? optOut(request, env) : NOT_ALLOWED();
  }
  if (path === "/v1/admin/feedback/board" || path === "/v1/admin/feedback/board/delist") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    if (path === "/v1/admin/feedback/board") return method === "GET" ? adminList(env) : NOT_ALLOWED();
    if (method === "POST") return delist(request, env, false);
    return method === "DELETE" ? delist(request, env, true) : NOT_ALLOWED();
  }
  return null;
}
