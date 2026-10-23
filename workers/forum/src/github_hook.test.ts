import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import type { Bindings } from "./env";
import { memoryD1 } from "./testdb";
import schema from "../schema.sql?raw";
import seed from "../seed.sql?raw";
import migration from "../migrate-github-projection.sql?raw";

const SECRET = "hook-secret";
const HOOK = "https://forum.reasonix.io/hooks/github/discussions";
const T0 = "2026-10-15T01:00:00Z";
const T1 = "2026-10-15T02:00:00Z";
const T2 = "2026-10-15T03:00:00Z";

let db: D1Database;
let env: Bindings;
let counter = 0;

afterEach(() => vi.useRealTimers());

// The fixtures are dated and the hook discards orphans older than a week, so the
// clock is pinned next to them; against the real date the test would expire.
beforeEach(async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T00:00:00Z"), toFake: ["Date"] });
  db = await memoryD1(schema, seed, migration,
    "INSERT INTO gh_category_map (gh_slug, forum_slug) VALUES ('q-a', 'help')");
  env = {
    DB: db, APP_ORIGIN: "https://reasonix.io", ALLOWED_ORIGINS: "https://reasonix.io", ID_ORIGIN: "https://id.reasonix.io",
    GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_REPO: "esengine/DeepSeek-Reasonix", GITHUB_REPO_ID: "42", GITHUB_INSTALLATION_ID: "9",
  };
  counter = 0;
});

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const repo = { id: 42, full_name: "esengine/DeepSeek-Reasonix", private: false };

function discussion(over: Record<string, unknown> = {}) {
  return {
    node_id: "D_1", number: 7, title: "Add folder fails on Windows", body: "Clicking add folder does nothing here.",
    user: { login: "Alice-Dev", type: "User" }, category: { slug: "q-a", name: "Q&A" },
    created_at: T0, updated_at: T0, state: "open", answer_chosen_at: null, labels: [], ...over,
  };
}

function comment(over: Record<string, unknown> = {}) {
  return { node_id: "DC_1", id: 101, parent_id: null, body: "Same here on 2.41.", user: { login: "bob", type: "User" }, created_at: T1, updated_at: T1, ...over };
}

async function send(event: string, payload: Record<string, unknown>, opts: { delivery?: string; secret?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify({ repository: repo, installation: { id: 9 }, ...payload });
  return app.request(HOOK, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json", "x-github-event": event,
      "x-github-delivery": opts.delivery ?? `d-${++counter}`,
      "x-hub-signature-256": await sign(body, opts.secret),
      ...opts.headers,
    },
  }, env);
}

async function topics() {
  const res = await app.request("https://forum.reasonix.io/topics", {}, env);
  return ((await res.json()) as { topics: Array<Record<string, unknown>> }).topics;
}

async function thread(id: number) {
  const res = await app.request(`https://forum.reasonix.io/topics/${id}`, {}, env);
  return (await res.json()) as { topic: Record<string, unknown>; posts: Array<Record<string, unknown>> };
}

const created = (over: Record<string, unknown> = {}) => send("discussion", { action: "created", discussion: discussion(over) });

describe("webhook trust", () => {
  it("does not exist until a secret is configured", async () => {
    delete env.GITHUB_WEBHOOK_SECRET;
    expect((await created()).status).toBe(404);
  });

  it("rejects a missing or wrong signature before reading anything", async () => {
    expect((await created()).status).toBe(200);
    const bad = await send("discussion", { action: "edited", discussion: discussion({ body: "x".repeat(20), updated_at: T1 }) }, { secret: "other" });
    expect(bad.status).toBe(401);
    const none = await app.request(HOOK, { method: "POST", body: "{}", headers: { "x-github-event": "discussion" } }, env);
    expect(none.status).toBe(401);
    expect((await thread(1)).posts[0]?.body).toBe("Clicking add folder does nothing here.");
  });

  it("accepts the previous secret during a rotation window", async () => {
    env.GITHUB_WEBHOOK_SECRET_PREVIOUS = "old-secret";
    expect((await send("discussion", { action: "created", discussion: discussion() }, { secret: "old-secret" })).status).toBe(200);
    expect(await topics()).toHaveLength(1);
  });

  it.each([
    ["another repository", { repository: { ...repo, id: 43, full_name: "someone/else" } }],
    ["a private repository", { repository: { ...repo, private: true } }],
    ["another installation", { installation: { id: 10 } }],
  ])("drops a signed event from %s with 202 and writes nothing", async (_n, over) => {
    const res = await send("discussion", { action: "created", discussion: discussion(), ...over });
    expect(res.status).toBe(202);
    expect(await topics()).toHaveLength(0);
  });

  it("refuses a body over the cap before parsing it", async () => {
    const big = JSON.stringify({ repository: repo, pad: "x".repeat(300_000) });
    expect((await send("discussion", {}, { raw: big })).status).toBe(413);
  });

  it("answers a ping and ignores unknown events and actions without failing", async () => {
    expect((await send("ping", { zen: "ok" })).status).toBe(200);
    expect((await send("push", { ref: "x" })).status).toBe(200);
    expect((await send("discussion", { action: "brand_new_action", discussion: discussion() })).status).toBe(200);
    expect(await topics()).toHaveLength(0);
  });
});

describe("projection", () => {
  it("shows a GitHub author under a namespaced handle no account can hold", async () => {
    await created();
    const [t] = await topics();
    expect(t).toMatchObject({ title: "Add folder fails on Windows", author: "Alice-Dev@github", category: "help", replyCount: 0, source: "github", ghNumber: 7 });
    const { posts } = await thread(Number(t!.id));
    expect(posts[0]).toMatchObject({ author: "Alice-Dev@github", body: "Clicking add folder does nothing here." });
    expect(JSON.stringify(await thread(Number(t!.id)))).not.toContain("github:");
  });

  it("applies the same delivery once", async () => {
    await send("discussion", { action: "created", discussion: discussion() }, { delivery: "same" });
    await send("discussion", { action: "edited", discussion: discussion({ body: "changed after the first delivery", updated_at: T1 }) }, { delivery: "same" });
    expect((await thread(1)).posts[0]?.body).toBe("Clicking add folder does nothing here.");
  });

  it("ignores an older edit that arrives after a newer one", async () => {
    await created();
    await send("discussion", { action: "edited", discussion: discussion({ body: "the newer text of the post", updated_at: T2 }) });
    await send("discussion", { action: "edited", discussion: discussion({ body: "the older text of the post", updated_at: T1 }) });
    expect((await thread(1)).posts[0]?.body).toBe("the newer text of the post");
  });

  it("never lets an old event resurrect a deleted discussion or comment", async () => {
    await created();
    await send("discussion_comment", { action: "created", discussion: discussion(), comment: comment() });
    await send("discussion_comment", { action: "deleted", discussion: discussion(), comment: comment({ updated_at: T2 }) });
    await send("discussion_comment", { action: "edited", discussion: discussion(), comment: comment({ body: "back from the dead", updated_at: T1 }) });
    await send("discussion", { action: "deleted", discussion: discussion({ updated_at: T2 }) });
    await send("discussion", { action: "created", discussion: discussion({ title: "Resurrected title here" }) });
    expect(await topics()).toHaveLength(0);
    const row = await db.prepare("SELECT body, status FROM posts WHERE gh_node_id = 'DC_1'").first<{ body: string; status: string }>();
    expect(row).toEqual({ body: "", status: "deleted" });
  });

  it("tombstones a delete that arrives before anything else was seen", async () => {
    await send("discussion", { action: "deleted", discussion: discussion({ updated_at: T2 }) });
    await created();
    expect(await topics()).toHaveLength(0);
  });

  it("holds a comment that arrives before its discussion and shows it once the discussion lands", async () => {
    await send("discussion_comment", { action: "created", discussion: discussion(), comment: comment() });
    expect(await topics()).toHaveLength(0);
    await created();
    const t = await thread(1);
    expect(t.posts.map((p) => p.body)).toEqual(["Clicking add folder does nothing here.", "Same here on 2.41."]);
    expect(t.topic.replyCount).toBe(1);
  });

  it("does not store a comment for a discussion that can never arrive, and bounds the ones that might", async () => {
    await send("discussion_comment", { action: "created", discussion: discussion({ category: { slug: "general", name: "General" } }), comment: comment() });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM gh_orphans").first<{ n: number }>())?.n).toBe(0);
    for (let i = 0; i < 520; i++) {
      await send("discussion_comment", { action: "created", discussion: discussion({ node_id: `D_${i}` }), comment: comment({ node_id: `DC_${i}`, id: 1000 + i }) });
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM gh_orphans").first<{ n: number }>())?.n).toBe(500);
    const stored = await db.prepare("SELECT payload FROM gh_orphans LIMIT 1").first<{ payload: string }>();
    expect(Object.keys(JSON.parse(stored!.payload).comment).sort()).toEqual(["body", "created_at", "id", "node_id", "parent_id", "updated_at", "user"]);
  });

  it("drops an event whose node id is not a plain GitHub node id, so it never reaches a query", async () => {
    const hostile = "D_1' OR 1=1; DROP TABLE topics; --";
    expect((await send("discussion", { action: "created", discussion: discussion({ node_id: hostile }) })).status).toBe(202);
    expect((await send("discussion_comment", { action: "created", discussion: discussion(), comment: comment({ node_id: "DC_x'--" }) })).status).toBe(202);
    expect(await topics()).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM gh_orphans").first<{ n: number }>())?.n).toBe(0);
  });

  it("logs an unmapped category once per discussion, however many events arrive", async () => {
    for (const action of ["created", "edited", "labeled"]) {
      await send("discussion", { action, discussion: discussion({ category: { slug: "polls", name: "Polls" } }) });
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mod_log").first<{ n: number }>())?.n).toBe(1);
  });

  it("forgets deliveries older than thirty days", async () => {
    await db.prepare("INSERT INTO gh_deliveries (delivery_id, received_at) VALUES ('ancient', '2026-01-01T00:00:00Z')").run();
    await created();
    expect(await db.prepare("SELECT 1 AS x FROM gh_deliveries WHERE delivery_id = 'ancient'").first()).toBeNull();
  });

  it("refuses a body with no Content-Length once it grows past the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(100_000));
        for (let i = 0; i < 4; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request(HOOK, { method: "POST", body: stream, duplex: "half", headers: { "x-github-event": "discussion", "x-hub-signature-256": "sha256=" + "0".repeat(64) } } as RequestInit, env);
    expect(res.status).toBe(413);
  });

  it("recomputes the reply count from the posts, so a deleted reply leaves it right", async () => {
    await created();
    await send("discussion_comment", { action: "created", discussion: discussion(), comment: comment() });
    await send("discussion_comment", { action: "created", discussion: discussion(), comment: comment({ node_id: "DC_2", id: 102, parent_id: 101, created_at: T2, updated_at: T2 }) });
    expect((await thread(1)).topic.replyCount).toBe(2);
    await send("discussion_comment", { action: "deleted", discussion: discussion(), comment: comment({ updated_at: T2 }) });
    expect((await thread(1)).topic.replyCount).toBe(1);
    const reply = await db.prepare("SELECT gh_parent_id AS p FROM posts WHERE gh_node_id = 'DC_2'").first<{ p: number }>();
    expect(reply?.p).toBe(101);
  });

  it("maps status labels, a closed state and the shipped version", async () => {
    await created({ labels: [{ name: "status:fixed:2.42.0" }, { name: "status:recorded" }] });
    const [t] = await topics();
    expect(t).toMatchObject({ ghStatus: "fixed", fixedIn: "2.42.0" });
    await send("discussion", { action: "closed", discussion: discussion({ state: "closed", updated_at: T1, labels: [] }) });
    expect((await topics())[0]).toMatchObject({ status: "closed", ghStatus: null, fixedIn: null });
  });

  it("keeps a moderator's hide across a later edit, and does not show hidden threads", async () => {
    await created();
    await db.prepare("UPDATE topics SET status = 'hidden'").run();
    await db.prepare("UPDATE posts SET status = 'hidden'").run();
    await send("discussion", { action: "edited", discussion: discussion({ body: "edited after the hide ok", updated_at: T1 }) });
    expect(await topics()).toHaveLength(0);
    expect((await db.prepare("SELECT status FROM posts").first<{ status: string }>())?.status).toBe("hidden");
  });

  it("drops a discussion in an unmapped category and says so in the moderator log", async () => {
    await created({ category: { slug: "announcements-gh", name: "News" } });
    expect(await topics()).toHaveLength(0);
    const log = await db.prepare("SELECT action, target FROM mod_log").first<{ action: string; target: string }>();
    expect(log).toEqual({ action: "gh_unmapped_category", target: "D_1" });
  });

  it("tombstones a discussion moved out of a mapped category", async () => {
    await created();
    await send("discussion", { action: "category_changed", discussion: discussion({ category: { slug: "elsewhere", name: "x" }, updated_at: T1 }) });
    expect(await topics()).toHaveLength(0);
  });

  it("makes a mirrored thread read-only for the forum's own replies, and leaves native threads open", async () => {
    await created();
    await db.prepare("INSERT INTO topics (category_id, author, title, slug, created_at, last_post_at) VALUES (2, 'm@x.io', 'Native topic', 'native', '2026-01-01', '2026-01-01')").run();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ user: { email: "m@x.io", handle: "m", emailVerified: true } })));
    await db.prepare("INSERT INTO members (email, handle, trust, role, created_at) VALUES ('m@x.io', 'm', 4, 'member', '2026-01-01')").run();
    const reply = (id: number) => app.request(`https://forum.reasonix.io/topics/${id}/posts`, {
      method: "POST", body: JSON.stringify({ body: "a native reply" }), headers: { "content-type": "application/json", cookie: "rxid=t" },
    }, env);
    const mirrored = await reply(1);
    expect(mirrored.status).toBe(409);
    await expect(mirrored.json()).resolves.toMatchObject({ error: { code: "read_only_mirror" } });
    expect((await reply(2)).status).toBe(201);
    vi.unstubAllGlobals();
  });
});
