// @ts-expect-error Node 22+ provides node:sqlite; Worker production code does not import it.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import { d1, fakeR2 } from "./feedback_testkit";
import { purgeStaleFeedback } from "./feedback_retention";
import { handleFeedbackRoute } from "./feedback_routes";
import { MAX_REPLIES_PER_ITEM } from "./feedback_types";
import feedbackMigrationSQL from "../migrate-feedback.sql?raw";
import triageMigrationSQL from "../migrate-feedback-triage.sql?raw";
import adoptionsMigrationSQL from "../migrate-feedback-adoptions.sql?raw";

const ADMIN = "admin-secret";
const admin = { authorization: `Bearer ${ADMIN}` };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

let env: Env;
let raw: DatabaseSync;
let objects: Map<string, unknown>;
let ipAllowed = true;
const tokens = new Map<string, string>();
const ids = { a: "install-aaaaaaaaaaaaaaaa", b: "install-bbbbbbbbbbbbbbbb", c: "install-cccccccccccccccc" };
let seq = 0;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec(feedbackMigrationSQL);
  raw.exec(triageMigrationSQL);
  raw.exec(adoptionsMigrationSQL);
  const r2 = fakeR2();
  objects = r2.objects;
  ipAllowed = true;
  tokens.clear();
  env = {
    DB: d1(raw),
    TELEMETRY_RAW: r2.bucket,
    FEEDBACK_LIMITER: { limit: async () => ({ success: ipAllowed }) },
    FEEDBACK_TOKEN_SECRET: "token-secret",
    FEEDBACK_ADMIN_TOKEN: ADMIN,
    FEEDBACK_ENABLED: "true",
  } as unknown as Env;
});

const call = (path: string, init: RequestInit = {}) => handleFeedbackRoute(new Request(`https://crash.test${path}`, init), env) as Promise<Response>;
const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  call(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const get = (path: string, headers: Record<string, string> = admin) => call(path, { headers });
const json = async <T = any>(r: Response) => (await r.json()) as T;
const errCode = async (r: Response) => (await json(r)).error.code as string;
const submission = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: `key-${++seq}-aaaaaaaa`,
  installId: ids.a,
  category: "bug",
  body: "the composer freezes",
  displayName: "Ada",
  env: { version: "v2.24.0" },
  ...over,
});
const submit = async (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  raw.exec("DELETE FROM feedback_quota WHERE bucket LIKE 'ip:%' OR bucket LIKE 'ih:%' OR bucket LIKE 'id:%'");
  const s = submission(over);
  const known = tokens.get(s.installId as string);
  const res = await post("/v1/feedback", s, known ? { "x-install-token": known, ...headers } : headers);
  if (res.status < 300) tokens.set(s.installId as string, (await json(res.clone())).installToken);
  return res;
};
const receiptOf = async (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => (await json(await submit(over, headers))).receipt as string;
const as = (id: string) => ({ "x-install-id": id, "x-install-token": tokens.get(id) ?? "" });
const act = (receipt: string, action: string, body: unknown = {}) => post(`/v1/admin/feedback/${receipt}/${action}`, body, admin);
const rowOf = (receipt: string) => raw.prepare("SELECT * FROM feedback WHERE receipt = ?").get(receipt) as any;
const statusOf = (receipt: string) => rowOf(receipt).status as string;
const mine = async (id: string) => (await json(await get("/v1/feedback/mine", as(id)))).items as any[];
const pendingItems = async () => (await json(await get("/v1/admin/feedback/pending"))).items as any[];
const hashOf = (receipt: string) => rowOf(receipt).install_hash as string;
const withImage = { attachments: [{ name: "a.png", contentType: "image/png", dataBase64: PNG_B64 }] };

const withdraw = (receipt: string, id = ids.a) => post(`/v1/feedback/${receipt}/withdraw`, {}, as(id));
const recorded = async (over: Record<string, unknown> = {}) => {
  await act(await receiptOf(), "release");
  const r = await receiptOf(over);
  await act(r, "recorded", { issueNumber: 777, issueUrl: "https://github.com/esengine/DeepSeek-Reasonix/issues/777" });
  return r;
};

describe("withdrawing a report", () => {
  it("lets the submitter withdraw a recorded report, and says so to them", async () => {
    const r = await recorded();
    const res = await withdraw(r);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ receipt: r, status: "withdrawn" });
    expect(statusOf(r)).toBe("withdrawn");
    expect((await mine(ids.a)).find((i) => i.receipt === r)).toMatchObject({ status: "withdrawn" });
  });

  it("is a no-op the second time", async () => {
    const r = await recorded();
    await withdraw(r);
    const again = await withdraw(r);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ status: "withdrawn" });
  });

  it("refuses an install that did not file it, without saying whether it exists", async () => {
    const r = await recorded();
    await submit({ installId: ids.b });
    const other = await withdraw(r, ids.b);
    expect(other.status).toBe(404);
    expect(await errCode(other)).toBe("feedback.not_found");
    expect(await errCode(await withdraw("FB-ZZZZ-ZZZZ", ids.b))).toBe("feedback.not_found");
    expect(statusOf(r)).toBe("recorded");
  });

  it("refuses a report that has already reached an outcome", async () => {
    const r = await recorded();
    expect((await act(r, "status", { status: "fixed", resolvedVersion: "v2.40.0" })).status).toBe(200);
    const res = await withdraw(r);
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("feedback.not_withdrawable");
    expect(statusOf(r)).toBe("fixed");
  });

  it("needs the install's own token", async () => {
    const r = await recorded();
    const res = await post(`/v1/feedback/${r}/withdraw`, {}, { "x-install-id": ids.a, "x-install-token": "wrong" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(statusOf(r)).toBe("recorded");
  });

  it("takes the report and its images off every public surface", async () => {
    const r = await recorded(withImage);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM feedback_public_images WHERE receipt = ?").get(r)).toEqual({ n: 1 });
    await withdraw(r);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM feedback_public_images WHERE receipt = ?").get(r)).toEqual({ n: 0 });
    expect(objects.size).toBe(0);
    expect(rowOf(r).attachments_json).toBe("[]");
  });

  it("finishes deleting the images when the first attempt failed to", async () => {
    const r = await recorded(withImage);
    const real = env.TELEMETRY_RAW!.delete.bind(env.TELEMETRY_RAW);
    let fail = true;
    (env.TELEMETRY_RAW as any).delete = async (ks: string | string[]) => {
      if (fail) throw new Error("r2 unavailable");
      return real(ks);
    };
    await expect(withdraw(r)).rejects.toThrow();
    expect(statusOf(r)).toBe("withdrawn");
    expect(objects.size).toBe(1);
    fail = false;
    const again = await withdraw(r);
    expect(again.status).toBe(200);
    expect(objects.size).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM feedback_public_images WHERE receipt = ?").get(r)).toEqual({ n: 0 });
    expect(rowOf(r).attachments_json).toBe("[]");
  });

  it("clears the contact the reporter left, in the same step as the status", async () => {
    const r = await recorded({ contact: "ada@example.com" });
    expect(rowOf(r).contact).toBe("ada@example.com");
    await withdraw(r);
    expect(rowOf(r).contact).toBe("");
    const detail = await json(await get(`/v1/admin/feedback/${r}`));
    expect(JSON.stringify(detail)).not.toContain("ada@example.com");
  });

  it("stops accepting replies on it", async () => {
    const r = await recorded();
    await withdraw(r);
    expect((await post(`/v1/feedback/${r}/reply`, { body: "wait" }, as(ids.a))).status).toBeGreaterThanOrEqual(400);
  });

  it("lists withdrawn reports that have an issue, for the maintainer to close it", async () => {
    const r = await recorded();
    const kept = await recorded();
    await withdraw(r);
    const listed = (await json(await get("/v1/admin/feedback/withdrawn"))).items as any[];
    expect(listed).toEqual([{ receipt: r, issueNumber: 777, issueUrl: expect.stringContaining("/issues/777") }]);
    expect(listed.map((i) => i.receipt)).not.toContain(kept);
  });
});
