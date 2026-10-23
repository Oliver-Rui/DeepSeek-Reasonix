import { describe, expect, it } from "vitest";
import { World } from "../testing/world";
import { CLI_SESSION_MAX_AGE_MS, SESSION_TTL_MS } from "../config";

const DAY = 24 * 60 * 60 * 1000;

async function sessionFor(world: World, kind: "web" | "cli") {
  const account = await world.addAccount();
  const token = await world.repos.sessions.create(account.id, { kind });
  const hash = (await world.repos.sessions.resolveSession(token))!.session.id;
  const set = (column: "expires_at" | "created_at", at: Date) =>
    world.store.raw.prepare(`UPDATE sessions SET ${column} = ? WHERE token_hash = ?`).run(at.toISOString(), hash);
  const row = () => world.rows<{ expires_at: string; created_at: string }>("SELECT expires_at, created_at FROM sessions WHERE token_hash = ?", hash)[0]!;
  return { token, set, row };
}

describe("a command-line session that is still in use", () => {
  it("is extended to a full term when it is used with less than a full term left", async () => {
    const world = new World();
    const { token, set, row } = await sessionFor(world, "cli");
    set("expires_at", new Date(Date.now() + 5 * DAY));
    await world.repos.sessions.resolveSession(token);
    const left = Date.parse(row().expires_at) - Date.now();
    expect(left).toBeGreaterThan(SESSION_TTL_MS - DAY);
  });

  it("is not rewritten on every use: a session renewed within the day is left alone", async () => {
    const world = new World();
    const { token, row } = await sessionFor(world, "cli");
    const before = row().expires_at;
    await world.repos.sessions.resolveSession(token);
    expect(row().expires_at).toBe(before);
  });

  it("never outlives the maximum age counted from when it was created", async () => {
    const world = new World();
    const { token, set, row } = await sessionFor(world, "cli");
    set("created_at", new Date(Date.now() - (CLI_SESSION_MAX_AGE_MS - 3 * DAY)));
    set("expires_at", new Date(Date.now() + DAY));
    await world.repos.sessions.resolveSession(token);
    const end = Date.parse(row().expires_at);
    expect(end).toBeLessThanOrEqual(Date.parse(row().created_at) + CLI_SESSION_MAX_AGE_MS);
    expect(end - Date.now()).toBeGreaterThan(0);
  });

  it("is still refused once it has expired, and an expired one is not revived by trying", async () => {
    const world = new World();
    const { token, set } = await sessionFor(world, "cli");
    set("expires_at", new Date(Date.now() - 1000));
    expect(await world.repos.sessions.resolveSession(token)).toBeNull();
    expect(await world.repos.sessions.resolveSession(token)).toBeNull();
  });
});

describe("a browser session", () => {
  it("keeps its fixed term: using it does not extend it", async () => {
    const world = new World();
    const { token, set, row } = await sessionFor(world, "web");
    const nearEnd = new Date(Date.now() + 5 * DAY);
    set("expires_at", nearEnd);
    await world.repos.sessions.resolveSession(token);
    expect(row().expires_at).toBe(nearEnd.toISOString());
  });
});
