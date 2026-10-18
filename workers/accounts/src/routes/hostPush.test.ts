import { afterEach, describe, expect, it, vi } from "vitest";
import { World, newPhone } from "../testing/world";
import { pushProofMessage } from "../auth/controllerProof";
import { generateSenderKey } from "../push/aes128gcm";
import { base64url, concat, fromBase64url } from "../push/encoding";
import { encodeKeys, generateVapidKeys } from "../push/vapid";

afterEach(() => vi.unstubAllGlobals());

const encoder = new TextEncoder();

// The receiver's half of RFC 8291, so a test can read what a push service would
// hand to a browser.
async function decrypt(body: Uint8Array, browser: { publicKey: Uint8Array; privateKey: Uint8Array }, authSecret: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20] as number;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const jwk = (publicKey: Uint8Array, d?: Uint8Array): JsonWebKey => ({
    kty: "EC", crv: "P-256", x: base64url(publicKey.slice(1, 33)), y: base64url(publicKey.slice(33, 65)), ext: true, ...(d ? { d: base64url(d) } : {}),
  });
  const mine = await crypto.subtle.importKey("jwk", jwk(browser.publicKey, browser.privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const theirs = await crypto.subtle.importKey("jwk", jwk(senderPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs } as unknown as SubtleCryptoDeriveKeyAlgorithm, mine, 256));
  const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode("WebPush: info\0"), browser.publicKey, senderPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ciphertext));
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  expect(plain[end - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, end - 1));
}

async function setup() {
  const vapid = encodeKeys(await generateVapidKeys());
  const world = new World({ bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@reasonix.io" } });
  const owner = await world.addAccount();
  const host = await world.addHost(owner.id);
  return { world, owner, host, vapid };
}

async function addPhone(s: Awaited<ReturnType<typeof setup>>, hostId: string, label: string, categories: { approval: boolean; input: boolean; error: boolean }) {
  const phone = await newPhone();
  const enrolled = await s.world.enroll(s.owner, phone, hostId);
  const controllerId = enrolled.body.controller.id as string;
  if (enrolled.status !== 200) {
    // A further phone waits for the person at the desktop, who adds it.
    const resolved = await s.world.hostCall("POST", `/host/controllers/${controllerId}/resolve`, { id: hostId, credential: s.host.credential }, { action: "add" });
    expect(resolved.status).toBe(200);
  }
  const browser = await generateSenderKey();
  const authSecret = new Uint8Array(16).fill(label.length);
  const endpoint = `https://fcm.googleapis.com/fcm/send/${label}`;
  const nonce = (await s.world.call("POST", "/me/remote-controllers/challenge", { cookie: s.owner.cookie, body: { host: hostId, purpose: "push" } })).body.nonce;
  const message = await pushProofMessage({ nonce, userId: s.owner.id, hostDeviceId: hostId, controllerId, endpoint });
  const response = await s.world.call("PUT", `/me/remote-push/${controllerId}`, {
    cookie: s.owner.cookie,
    body: { host: hostId, nonce, signature: await phone.sign(message), subscription: { endpoint, keys: { p256dh: base64url(browser.publicKey), auth: base64url(authSecret) } }, categories },
  });
  expect(response.status).toBe(200);
  return { phone, controllerId, browser, authSecret, endpoint };
}

interface Sent { url: string; headers: Record<string, string>; body: Uint8Array }

function stubPushServices(status: number | ((url: string) => number) = 201): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response(null, { status: typeof status === "function" ? status(url) : status });
  });
  return sent;
}

const notify = (s: Awaited<ReturnType<typeof setup>>, body: unknown) => s.world.hostCall("POST", "/host/push/notify", s.host, body);

describe("a desktop telling its phones that something is waiting", () => {
  it("sends one encrypted message per enabled phone, and it says only the type and a count", async () => {
    const s = await setup();
    const a = await addPhone(s, s.host.id, "phone-a", { approval: true, input: false, error: false });
    const b = await addPhone(s, s.host.id, "phone-b", { approval: true, input: true, error: false });
    const sent = stubPushServices();
    const response = await notify(s, { type: "approval", count: 3 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: 2, failed: 0, removed: 0 });
    expect(sent.map((x) => x.url).sort()).toEqual([a.endpoint, b.endpoint].sort());
    for (const message of sent) {
      const who = message.url === a.endpoint ? a : b;
      expect(JSON.parse(await decrypt(message.body, who.browser, who.authSecret))).toEqual({ v: 1, type: "approval", count: 3 });
      expect(message.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(message.headers.TTL).toBe("120");
      expect(message.headers.Topic).toBe("approval");
      expect(message.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    }
    expect(s.world.rows<Record<string, unknown>>("SELECT last_success_at FROM remote_push_subscriptions").every((r) => r.last_success_at !== null)).toBe(true);
  });

  it("sends nothing to a phone that did not turn that category on", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: false, input: false, error: false });
    const sent = stubPushServices();
    expect((await notify(s, { type: "error" })).body).toEqual({ delivered: 0, failed: 0, removed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("has no field that can carry conversation text", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: true, input: true, error: true });
    const sent = stubPushServices();
    for (const body of [
      { type: "approval", summary: "rm -rf /" },
      { type: "approval", count: 1, text: "secret" },
      { type: "message", count: 1 },
      { type: "approval", count: 100 },
      { type: "approval", count: 0 },
      { type: "approval", count: "3" },
      {},
    ]) {
      expect((await notify(s, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(sent).toHaveLength(0);
  });

  it("needs the desktop's own credential and only reaches that desktop's phones", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: true, input: true, error: true });
    const otherHost = await s.world.addHost(s.owner.id);
    const stranger = await s.world.addAccount();
    const strangerHost = await s.world.addHost(stranger.id);
    const sent = stubPushServices();
    expect((await s.world.call("POST", "/host/push/notify", { body: { type: "approval" } })).status).toBe(401);
    expect((await s.world.call("POST", "/host/push/notify", { body: { type: "approval" }, headers: { "x-reasonix-device-id": s.host.id, "x-reasonix-device-credential": "0".repeat(64) } })).status).toBe(401);
    expect((await s.world.hostCall("POST", "/host/push/notify", otherHost, { type: "approval" })).body.delivered).toBe(0);
    expect((await s.world.hostCall("POST", "/host/push/notify", strangerHost, { type: "approval" })).body.delivered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("does not send to a phone whose controller was revoked, even if its row survived", async () => {
    const s = await setup();
    const a = await addPhone(s, s.host.id, "phone-a", { approval: true, input: true, error: true });
    s.world.store.raw.prepare("UPDATE remote_controllers SET state = 'revoked', revoked_at = ?1 WHERE id = ?2").run(new Date().toISOString(), a.controllerId);
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(1);
    const sent = stubPushServices();
    expect((await notify(s, { type: "approval" })).body.delivered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("does not send for a revoked desktop at all", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: true, input: true, error: true });
    s.world.store.raw.prepare("UPDATE remote_devices SET revoked_at = ?1 WHERE id = ?2").run(new Date().toISOString(), s.host.id);
    const sent = stubPushServices();
    expect((await notify(s, { type: "approval" })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("drops a subscription the push service says is gone, and keeps the others", async () => {
    const s = await setup();
    const a = await addPhone(s, s.host.id, "phone-a", { approval: true, input: false, error: false });
    const b = await addPhone(s, s.host.id, "phone-b", { approval: true, input: false, error: false });
    stubPushServices((url) => (url === a.endpoint ? 410 : 201));
    expect((await notify(s, { type: "approval" })).body).toEqual({ delivered: 1, failed: 0, removed: 1 });
    expect(s.world.rows<{ controller_id: string }>("SELECT controller_id FROM remote_push_subscriptions").map((r) => r.controller_id)).toEqual([b.controllerId]);
    stubPushServices(404);
    expect((await notify(s, { type: "approval" })).body.removed).toBe(1);
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
  });

  it("waits out a failing endpoint with a growing delay, and shows the failure to the person", async () => {
    const s = await setup();
    const a = await addPhone(s, s.host.id, "phone-a", { approval: true, input: false, error: false });
    const sent = stubPushServices(503);
    expect((await notify(s, { type: "approval" })).body).toEqual({ delivered: 0, failed: 1, removed: 0 });
    const first = s.world.rows<Record<string, unknown>>("SELECT * FROM remote_push_subscriptions")[0]!;
    expect(first).toMatchObject({ failure_count: 1, last_failure_status: 503 });
    expect(Date.parse(first.next_attempt_at as string) - Date.parse(first.last_failure_at as string)).toBe(60_000);
    // Inside the wait nothing is sent.
    expect((await notify(s, { type: "approval" })).body).toEqual({ delivered: 0, failed: 0, removed: 0 });
    expect(sent).toHaveLength(1);
    // After it, a second failure doubles it.
    s.world.store.raw.prepare("UPDATE remote_push_subscriptions SET next_attempt_at = ?1").run(new Date(Date.now() - 1000).toISOString());
    await notify(s, { type: "approval" });
    const second = s.world.rows<Record<string, unknown>>("SELECT * FROM remote_push_subscriptions")[0]!;
    expect(second.failure_count).toBe(2);
    expect(Date.parse(second.next_attempt_at as string) - Date.parse(second.last_failure_at as string)).toBe(120_000);
    const view = await s.world.call("GET", `/me/remote-push/${a.controllerId}`, { cookie: s.owner.cookie });
    expect(view.body.subscription).toMatchObject({ failureCount: 2, lastFailureStatus: 503 });
    // A later success clears it.
    stubPushServices(201);
    s.world.store.raw.prepare("UPDATE remote_push_subscriptions SET next_attempt_at = NULL").run();
    await notify(s, { type: "approval" });
    expect(s.world.rows<Record<string, unknown>>("SELECT * FROM remote_push_subscriptions")[0]).toMatchObject({ failure_count: 0, last_failure_status: null, next_attempt_at: null });
  });

  it("treats a network error like a retryable failure and never follows a redirect", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: true, input: false, error: false });
    vi.stubGlobal("fetch", async () => { throw new Error("connection reset"); });
    expect((await notify(s, { type: "approval" })).body).toEqual({ delivered: 0, failed: 1, removed: 0 });
    s.world.store.raw.prepare("UPDATE remote_push_subscriptions SET next_attempt_at = NULL").run();
    const redirects: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { redirects.push(init.redirect); return new Response(null, { status: 302 }); });
    expect((await notify(s, { type: "approval" })).body.failed).toBe(1);
    expect(redirects).toEqual(["manual"]);
  });

  it("limits a desktop's notifications of one type, and says when notifications are not configured", async () => {
    const s = await setup();
    await addPhone(s, s.host.id, "phone-a", { approval: true, input: false, error: false });
    stubPushServices();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) statuses.push((await notify(s, { type: "approval" })).status);
    expect(statuses.filter((x) => x === 429).length).toBeGreaterThan(0);
    const bare = new World();
    const owner = await bare.addAccount();
    const host = await bare.addHost(owner.id);
    const response = await bare.hostCall("POST", "/host/push/notify", host, { type: "approval" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("push_unavailable");
  });
});
