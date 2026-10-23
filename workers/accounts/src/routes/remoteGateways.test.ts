import { describe, expect, it } from "vitest";
import { World } from "../testing/world";
import { normalizeGatewayOrigin } from "../db/remoteGateways";

const HOSTED = "hosted-secret";
const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function setup() {
  const world = new World({ bindings: { REMOTE_GATEWAY_TOKEN: HOSTED } });
  const account = await world.addAccount();
  const own = await world.call("POST", "/me/gateways", { cookie: account.cookie, body: { label: "home", origin: "https://relay.example.com" } });
  expect(own.status).toBe(201);
  const device = await world.call("POST", "/me/devices", {
    cookie: account.cookie,
    body: { name: "mine", platform: "linux", publicKey: key(), capabilities: ["tasks"], gatewayId: own.body.gateway.id },
  });
  expect(device.status).toBe(201);
  const hosted = await world.addHost(account.id);
  return { world, account, token: own.body.token as string, gatewayId: own.body.gateway.id as string, device: device.body, hosted };
}

const asGateway = (token: string) => ({ "x-reasonix-gateway-token": token });

describe("a registered gateway", () => {
  it("authenticates only the devices bound to it", async () => {
    const { world, token, device, hosted } = await setup();
    const mine = await world.call("POST", "/remote/devices/authenticate", {
      headers: asGateway(token), body: { deviceId: device.device.id, deviceCredential: device.deviceCredential },
    });
    expect(mine.status).toBe(200);
    const theirs = await world.call("POST", "/remote/devices/authenticate", {
      headers: asGateway(token), body: { deviceId: hosted.id, deviceCredential: hosted.credential },
    });
    expect(theirs.status).toBe(401);
  });

  it("is refused for the hosted gateway's devices in the lease check, and the hosted secret is refused for its devices", async () => {
    const { world, account, token, device, hosted } = await setup();
    const lease = (deviceId: string) => ({ leases: [{ userId: account.id, deviceId }] });
    const own = await world.call("POST", "/remote/leases/check", { headers: asGateway(token), body: lease(device.device.id) });
    expect(own.body.verdicts).toEqual(["active"]);
    const foreign = await world.call("POST", "/remote/leases/check", { headers: asGateway(token), body: lease(hosted.id) });
    expect(foreign.body.verdicts).toEqual(["revoked"]);
    const hostedAnswer = await world.call("POST", "/remote/leases/check", { headers: asGateway(HOSTED), body: lease(device.device.id) });
    expect(hostedAnswer.body.verdicts).toEqual(["revoked"]);
  });

  it("cannot consume a grant issued for a device on another gateway", async () => {
    const { world, account, token, hosted } = await setup();
    const ticket = await world.repos.remoteDevices.issueGrant({
      userId: account.id, targetDeviceId: hosted.id, scopes: ["tasks"], ttlMs: 60_000, session: { id: account.sessionHash, createdAt: new Date().toISOString() },
    });
    const refused = await world.call("POST", "/remote/grants/consume", { headers: asGateway(token), body: { ticket: ticket.ticket } });
    expect(refused.status).toBe(401);
    const accepted = await world.call("POST", "/remote/grants/consume", { headers: asGateway(HOSTED), body: { ticket: ticket.ticket } });
    expect(accepted.status).toBe(200);
  });

  it("cannot touch attachments", async () => {
    const { world, token } = await setup();
    const response = await world.call("POST", "/remote/attachments/download", { headers: asGateway(token), body: { objectId: "a".repeat(32), ticket: "b".repeat(32) } });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("gateway_scope");
  });

  it("stops working when the gateway is removed, and removing it revokes its devices", async () => {
    const { world, account, token, gatewayId, device } = await setup();
    const removed = await world.call("DELETE", `/me/gateways/${gatewayId}`, { cookie: account.cookie });
    expect(removed.body).toEqual({ ok: true, revokedDevices: 1 });
    const after = await world.call("POST", "/remote/devices/authenticate", {
      headers: asGateway(token), body: { deviceId: device.device.id, deviceCredential: device.deviceCredential },
    });
    expect(after.status).toBe(401);
  });

  it("is not accepted from a wrong or absent token", async () => {
    const { world } = await setup();
    expect((await world.call("POST", "/remote/leases/check", { headers: asGateway("nope"), body: { leases: [] } })).status).toBe(401);
    expect((await world.call("POST", "/remote/leases/check", { body: { leases: [] } })).status).toBe(401);
  });
});

describe("registering a gateway", () => {
  it("shows the token once and keeps only its hash", async () => {
    const { world, token, gatewayId } = await setup();
    expect(token).toHaveLength(64);
    const rows = world.rows<{ token_hash: string }>("SELECT token_hash FROM remote_gateways WHERE id = ?", gatewayId);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it("refuses a second registration of the same origin and a fourth gateway", async () => {
    const { world, account } = await setup();
    const again = await world.call("POST", "/me/gateways", { cookie: account.cookie, body: { label: "dup", origin: "https://relay.example.com" } });
    expect(again.body.error.code).toBe("gateway_exists");
    for (const host of ["a", "b"]) {
      expect((await world.call("POST", "/me/gateways", { cookie: account.cookie, body: { label: host, origin: `https://${host}.example.org` } })).status).toBe(201);
    }
    const over = await world.call("POST", "/me/gateways", { cookie: account.cookie, body: { label: "d", origin: "https://d.example.org" } });
    expect(over.body.error.code).toBe("gateway_limit");
  });

  it("does not let one account bind a device to another account's gateway", async () => {
    const { world, gatewayId } = await setup();
    const other = await world.addAccount();
    const response = await world.call("POST", "/me/devices", {
      cookie: other.cookie, body: { name: "x", platform: "linux", publicKey: key(), capabilities: ["tasks"], gatewayId },
    });
    expect(response.status).toBe(404);
  });

  it("needs a signed-in account", async () => {
    const world = new World();
    expect((await world.call("POST", "/me/gateways", { body: { label: "x", origin: "https://a.example.com" } })).status).toBe(401);
  });
});

describe("gateway origins", () => {
  it.each([
    ["https://relay.example.com", "https://relay.example.com"],
    ["https://Relay.Example.com/", "https://relay.example.com"],
    ["https://relay.example.com:8443", "https://relay.example.com:8443"],
  ])("accepts %s", (input, want) => expect(normalizeGatewayOrigin(input)).toBe(want));

  it.each([
    "http://relay.example.com", "wss://relay.example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.5",
    "https://[::1]", "https://user:pw@relay.example.com", "https://relay.example.com/path", "https://relay.example.com/?x=1",
    "https://intranet", "https://box.local", "https://box.internal", "not a url",
  ])("refuses %s", (input) => expect(normalizeGatewayOrigin(input)).toBeNull());
});
