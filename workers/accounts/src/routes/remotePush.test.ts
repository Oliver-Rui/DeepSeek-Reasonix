import { describe, expect, it } from "vitest";
import { controllerIdFor, pushProofMessage } from "../auth/controllerProof";
import { World, newPhone, type Phone } from "../testing/world";
import { base64url } from "../push/encoding";
import { encodeKeys, generateVapidKeys } from "../push/vapid";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

function browserKeys() {
  const point = new Uint8Array(65).fill(9);
  point[0] = 4;
  return { p256dh: base64url(point), auth: base64url(new Uint8Array(16).fill(3)) };
}

async function setup(options: { vapid?: boolean } = {}) {
  const vapid = encodeKeys(await generateVapidKeys());
  const world = new World({
    bindings: options.vapid === false ? {} : { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@reasonix.io" },
  });
  const owner = await world.addAccount();
  const host = await world.addHost(owner.id);
  const phone = await newPhone();
  const enrolled = await world.enroll(owner, phone, host.id);
  const controllerId = enrolled.body.controller.id as string;
  return { world, owner, host, phone, controllerId };
}

async function subscribe(
  s: Awaited<ReturnType<typeof setup>>,
  options: { endpoint?: string; keys?: { p256dh: string; auth: string }; signedKeys?: { p256dh: string; auth: string }; categories?: Record<string, boolean>; phone?: Phone; nonce?: string; signedEndpoint?: string; controllerId?: string; hostId?: string } = {},
) {
  const endpoint = options.endpoint ?? ENDPOINT;
  const hostId = options.hostId ?? s.host.id;
  const nonce = options.nonce ?? (await s.world.call("POST", "/me/remote-controllers/challenge", { cookie: s.owner.cookie, body: { host: hostId, purpose: "push" } })).body.nonce;
  const keys = options.keys ?? browserKeys();
  const signedKeys = options.signedKeys ?? keys;
  const message = await pushProofMessage({
    nonce, userId: s.owner.id, hostDeviceId: hostId, controllerId: options.controllerId ?? s.controllerId,
    endpoint: options.signedEndpoint ?? endpoint, p256dh: signedKeys.p256dh, auth: signedKeys.auth,
  });
  return s.world.call("PUT", `/me/remote-push/${options.controllerId ?? s.controllerId}`, {
    cookie: s.owner.cookie,
    body: {
      host: hostId, nonce, signature: await (options.phone ?? s.phone).sign(message),
      subscription: { endpoint, keys },
      ...(options.categories ? { categories: options.categories } : {}),
    },
  });
}

const noSecrets = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/endpoint|p256dh|auth|fcm\.googleapis|device-1/);

describe("the push application server key", () => {
  it("is served to a signed-in browser, and only the public half", async () => {
    const s = await setup();
    const response = await s.world.call("GET", "/me/remote-push/key", { cookie: s.owner.cookie });
    expect(response.status).toBe(200);
    expect(response.body.publicKey).toBe(s.world.env.VAPID_PUBLIC_KEY);
    expect(JSON.stringify(response.body)).not.toContain(s.world.env.VAPID_PRIVATE_KEY as string);
    expect((await s.world.call("GET", "/me/remote-push/key")).status).toBe(401);
  });

  it("is unavailable, not an error page, until a key is configured", async () => {
    const s = await setup({ vapid: false });
    const response = await s.world.call("GET", "/me/remote-push/key", { cookie: s.owner.cookie });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("push_unavailable");
    expect((await subscribe(s)).body.error.code).toBe("push_unavailable");
  });
});

describe("attaching a subscription to a controller", () => {
  it("stores it with nothing enabled, and never returns the endpoint or keys", async () => {
    const s = await setup();
    const response = await subscribe(s);
    expect(response.status).toBe(200);
    expect(response.body.subscription).toMatchObject({ controllerId: s.controllerId, categories: { approval: false, input: false, error: false }, failureCount: 0 });
    noSecrets(response.body);
    const row = s.world.rows<Record<string, unknown>>("SELECT * FROM remote_push_subscriptions")[0]!;
    expect(row).toMatchObject({ controller_id: s.controllerId, user_id: s.owner.id, host_device_id: s.host.id, endpoint: ENDPOINT, notify_approval: 0, notify_input: 0, notify_error: 0 });
    const read = await s.world.call("GET", `/me/remote-push/${s.controllerId}`, { cookie: s.owner.cookie });
    expect(read.status).toBe(200);
    noSecrets(read.body);
  });

  it("takes the categories the person chose, and a new subscription replaces the old one", async () => {
    const s = await setup();
    await subscribe(s, { categories: { approval: true, input: false, error: true } });
    await subscribe(s, { endpoint: "https://fcm.googleapis.com/fcm/send/device-2", categories: { approval: false, input: true, error: false } });
    const rows = s.world.rows<Record<string, unknown>>("SELECT * FROM remote_push_subscriptions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "https://fcm.googleapis.com/fcm/send/device-2", notify_approval: 0, notify_input: 1, notify_error: 0 });
  });

  it("changes categories with the browser session alone, and leaves everything else", async () => {
    const s = await setup();
    await subscribe(s);
    const response = await s.world.call("PATCH", `/me/remote-push/${s.controllerId}`, { cookie: s.owner.cookie, body: { categories: { approval: true, input: true, error: false } } });
    expect(response.status).toBe(200);
    expect(response.body.subscription.categories).toEqual({ approval: true, input: true, error: false });
    expect(s.world.rows<Record<string, unknown>>("SELECT endpoint FROM remote_push_subscriptions")[0]).toMatchObject({ endpoint: ENDPOINT });
    const unknownCategory = await s.world.call("PATCH", `/me/remote-push/${s.controllerId}`, { cookie: s.owner.cookie, body: { categories: { approval: true, input: true, error: false, extra: true } } });
    expect(unknownCategory.status).toBe(422);
  });

  it("needs a proof made by the controller's own key, over this subscription", async () => {
    const s = await setup();
    const other = await newPhone();
    expect((await subscribe(s, { phone: other })).body.error.code).toBe("invalid_proof");
    expect((await subscribe(s, { signedEndpoint: "https://fcm.googleapis.com/fcm/send/other" })).body.error.code).toBe("invalid_proof");
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
    expect((await subscribe(s)).status).toBe(200);
  });

  it("refuses a signature that is right for the endpoint when the keys sent are not the ones signed", async () => {
    const s = await setup();
    const signed = browserKeys();
    const attacker = { p256dh: signed.p256dh, auth: base64url(new Uint8Array(16).fill(200)) };
    const attackerPoint = new Uint8Array(65).fill(11);
    attackerPoint[0] = 4;
    for (const keys of [attacker, { p256dh: base64url(attackerPoint), auth: signed.auth }, { p256dh: base64url(attackerPoint), auth: attacker.auth }]) {
      const response = await subscribe(s, { keys, signedKeys: signed });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("invalid_proof");
    }
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
    expect((await subscribe(s, { keys: signed })).status).toBe(200);
  });

  it("answers a stored key that cannot be read with a typed refusal, not an error page", async () => {
    const s = await setup();
    s.world.store.raw.prepare("UPDATE remote_controllers SET public_key = 'not json' WHERE id = ?1").run(s.controllerId);
    const response = await subscribe(s);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("invalid_key");
  });

  it("burns the challenge on use and keeps an enrollment challenge from being spent here", async () => {
    const s = await setup();
    const nonce = (await s.world.call("POST", "/me/remote-controllers/challenge", { cookie: s.owner.cookie, body: { host: s.host.id, purpose: "push" } })).body.nonce;
    expect((await subscribe(s, { nonce })).status).toBe(200);
    expect((await subscribe(s, { nonce })).body.error.code).toBe("challenge_invalid");
    const enrollNonce = await s.world.challenge(s.owner, s.host.id);
    expect((await subscribe(s, { nonce: enrollNonce })).body.error.code).toBe("challenge_invalid");
  });

  it("is only for an active controller of the caller's own, on one of their hosts", async () => {
    const s = await setup();
    const stranger = await s.world.addAccount();
    const strangerHost = await s.world.addHost(stranger.id);
    const strangerPhone = await newPhone();
    const strangerController = (await s.world.enroll(stranger, strangerPhone, strangerHost.id)).body.controller.id as string;
    const missing = await subscribe(s, { controllerId: strangerController });
    expect(missing.status).toBe(404);
    const unknown = await subscribe(s, { controllerId: await controllerIdFor(s.host.id, "x".repeat(43)) });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(missing.body);
    expect((await s.world.call("GET", `/me/remote-push/${s.controllerId}`, { cookie: stranger.cookie })).status).toBe(404);
    const revoked = await s.world.call("POST", `/me/remote-controllers/${s.controllerId}/revoke`, { cookie: s.owner.cookie });
    expect(revoked.status).toBe(200);
    expect((await subscribe(s)).status).toBe(404);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/x",
    "https://169.254.169.254/latest/meta-data",
    "https://internal.example/hook",
    "https://fcm.googleapis.com.evil.example/x",
    "https://localhost/x",
  ])("refuses the address %s before spending the challenge", async (endpoint) => {
    const s = await setup();
    const nonce = (await s.world.call("POST", "/me/remote-controllers/challenge", { cookie: s.owner.cookie, body: { host: s.host.id, purpose: "push" } })).body.nonce;
    const response = await subscribe(s, { endpoint, nonce });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("invalid_endpoint");
    expect((await subscribe(s, { nonce })).status).toBe(200);
  });

  it("refuses keys of the wrong shape", async () => {
    const s = await setup();
    expect((await subscribe(s, { keys: { p256dh: "AAAA", auth: browserKeys().auth } })).body.error.code).toBe("invalid_keys");
    expect((await subscribe(s, { keys: { p256dh: browserKeys().p256dh, auth: "AAAA" } })).body.error.code).toBe("invalid_keys");
  });

  it("needs a browser session signed in recently, like enrolling does", async () => {
    const s = await setup();
    const cli = await s.world.addSession(s.owner.id, "cli");
    const response = await s.world.call("PUT", `/me/remote-push/${s.controllerId}`, { cookie: cli.cookie, body: {} });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("remote_reauth_required");
  });

  it("limits how often one sign-in can attach subscriptions", async () => {
    const s = await setup();
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await subscribe(s, { endpoint: `https://fcm.googleapis.com/fcm/send/d${i}` });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("a subscription ends with what it belongs to", () => {
  it("is deleted by the person, and deleting again is not an error", async () => {
    const s = await setup();
    await subscribe(s);
    expect((await s.world.call("DELETE", `/me/remote-push/${s.controllerId}`, { cookie: s.owner.cookie })).status).toBe(204);
    expect((await s.world.call("DELETE", `/me/remote-push/${s.controllerId}`, { cookie: s.owner.cookie })).status).toBe(204);
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
  });

  it("cannot be deleted by someone else", async () => {
    const s = await setup();
    await subscribe(s);
    const stranger = await s.world.addAccount();
    expect((await s.world.call("DELETE", `/me/remote-push/${s.controllerId}`, { cookie: stranger.cookie })).status).toBe(204);
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(1);
  });

  it("goes when the controller is revoked, from the desktop side too", async () => {
    const s = await setup();
    await subscribe(s);
    await s.world.call("POST", `/me/remote-controllers/${s.controllerId}/revoke`, { cookie: s.owner.cookie });
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);

    const t = await setup();
    await subscribe(t);
    const viaHost = await t.world.hostCall("POST", `/host/controllers/${t.controllerId}/revoke`, t.host, {});
    expect([200, 204]).toContain(viaHost.status);
    expect(t.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
  });

  it("goes when its host is revoked, and when every device of the account is", async () => {
    const s = await setup();
    await subscribe(s);
    const second = await s.world.addHost(s.owner.id);
    const phone2 = await newPhone();
    const controller2 = (await s.world.enroll(s.owner, phone2, second.id)).body.controller.id as string;
    const nonce = (await s.world.call("POST", "/me/remote-controllers/challenge", { cookie: s.owner.cookie, body: { host: second.id, purpose: "push" } })).body.nonce;
    await subscribe(s, { hostId: second.id, controllerId: controller2, phone: phone2, endpoint: "https://fcm.googleapis.com/fcm/send/device-2", nonce });
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(2);
    await s.world.repos.remoteDevices.revoke(s.owner.id, second.id);
    expect(s.world.rows<{ controller_id: string }>("SELECT controller_id FROM remote_push_subscriptions").map((r) => r.controller_id)).toEqual([s.controllerId]);
    await s.world.repos.remoteDevices.revokeAllForUser(s.owner.id);
    expect(s.world.rows("SELECT 1 FROM remote_push_subscriptions")).toHaveLength(0);
  });
});
