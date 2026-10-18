import { describe, expect, it, vi } from "vitest";
import { accountClient } from "./phone_device";
import { EnableRefused, disablePush, enablePush, pushStatus, setCategories, type BrowserSubscription, type PushBrowser } from "./phone_push";
import { base64url, fromBase64url, generateDeviceKey, pushMessage, sign } from "./phone_proof";

const HOST = "ab".repeat(32);
const DEVICE = { id: "rc_device", state: "active" as const, name: "iPhone Safari" };
const SUBSCRIPTION: BrowserSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", p256dh: "BPp-key", auth: "auth-secret" };
const VAPID = base64url(new Uint8Array(65).fill(4));
const CATEGORIES = { approval: true, input: false, error: true };

function browser(over: Partial<PushBrowser> = {}): PushBrowser & { subscribed: Uint8Array[]; unsubscribed: number } {
  const state = { subscribed: [] as Uint8Array[], unsubscribed: 0 };
  return Object.assign(state, {
    supported: () => true,
    permission: () => "default" as NotificationPermission,
    requestPermission: async () => "granted" as NotificationPermission,
    subscribe: async (key: Uint8Array) => { state.subscribed.push(key); return SUBSCRIPTION; },
    unsubscribe: async () => { state.unsubscribed++; },
    ...over,
  });
}

function server() {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://id.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method: String(init?.method), path, body });
    const reply = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (path === "/me/remote-push/key") return reply(200, { publicKey: VAPID });
    if (path === "/me/remote-controllers/challenge") return reply(200, { nonce: "ef".repeat(32) });
    if (init?.method === "PUT") return reply(200, { subscription: { categories: body.categories, lastFailureAt: null, lastFailureStatus: null, failureCount: 0 } });
    if (init?.method === "PATCH") return reply(200, { subscription: { categories: body.categories, lastFailureAt: null, lastFailureStatus: null, failureCount: 0 } });
    if (init?.method === "DELETE") return reply(204);
    if (path === "/me/remote-push/rc_none") return reply(404, { error: { code: "controller_not_found" } });
    return reply(200, { subscription: { categories: CATEGORIES, lastFailureAt: "t", lastFailureStatus: 410, failureCount: 3 } });
  }) as unknown as typeof fetch;
  return { calls, account: accountClient("https://id.test", send) };
}

describe("switching phone notifications on", () => {
  it("asks permission, subscribes with the service's key, and attaches the address with a proof over it", async () => {
    const s = server(), b = browser(), key = await generateDeviceKey();
    const status = await enablePush(s.account, b, (m) => sign(key.privateKey, m), HOST, DEVICE, 7, CATEGORIES);

    expect(status.categories).toEqual(CATEGORIES);
    expect(Array.from(b.subscribed[0])).toEqual(Array.from(fromBase64url(VAPID)));
    const put = s.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/me/remote-push/rc_device");
    expect(put.body.subscription).toEqual({ endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth } });
    const message = await pushMessage({ nonce: "ef".repeat(32), userId: 7, host: HOST, deviceId: "rc_device", ...SUBSCRIPTION });
    const verifier = await crypto.subtle.importKey("jwk", key.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromBase64url(String(put.body.signature)), message)).toBe(true);
  });

  it("does not ask again once permission is already granted", async () => {
    const request = vi.fn(async () => "granted" as NotificationPermission);
    const key = await generateDeviceKey();
    await enablePush(server().account, browser({ permission: () => "granted", requestPermission: request }), (m) => sign(key.privateKey, m), HOST, DEVICE, 7, CATEGORIES);
    expect(request).not.toHaveBeenCalled();
  });

  it("stops at a refused permission without telling the account anything", async () => {
    const s = server(), b = browser({ requestPermission: async () => "denied" });
    await expect(enablePush(s.account, b, async () => "", HOST, DEVICE, 7, CATEGORIES)).rejects.toMatchObject({ reason: "denied" });
    expect(s.calls).toEqual([]);
    expect(b.subscribed).toEqual([]);
  });

  it("names a browser that cannot reach its push service, and sends the account nothing", async () => {
    const s = server();
    const b = browser({ subscribe: async () => { throw new DOMException("Registration failed - permission denied", "AbortError"); } });
    await expect(enablePush(s.account, b, async () => "", HOST, DEVICE, 7, CATEGORIES)).rejects.toMatchObject({ reason: "push_service" });
    expect(s.calls.map((c) => c.path)).toEqual(["/me/remote-push/key"]);
  });

  it("refuses a browser without push and a phone the desktop has not approved", async () => {
    const s = server();
    await expect(enablePush(s.account, browser({ supported: () => false }), async () => "", HOST, DEVICE, 7, CATEGORIES)).rejects.toBeInstanceOf(EnableRefused);
    await expect(enablePush(s.account, browser(), async () => "", HOST, { ...DEVICE, state: "pending" }, 7, CATEGORIES)).rejects.toMatchObject({ reason: "not_active" });
    expect(s.calls).toEqual([]);
  });
});

describe("a switched-on phone", () => {
  it("reads its state, including a failing address, and treats none as none", async () => {
    const s = server();
    expect(await pushStatus(s.account, "rc_device")).toMatchObject({ failureCount: 3, lastFailureStatus: 410 });
    expect(await pushStatus(s.account, "rc_none")).toBeNull();
  });

  it("changes categories without resubscribing", async () => {
    const s = server();
    expect((await setCategories(s.account, "rc_device", { approval: false, input: true, error: false })).categories).toEqual({ approval: false, input: true, error: false });
    expect(s.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("switching off removes the account's copy and the browser's subscription", async () => {
    const s = server(), b = browser();
    await disablePush(s.account, b, "rc_device");
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /me/remote-push/rc_device"]);
    expect(b.unsubscribed).toBe(1);
  });
});
