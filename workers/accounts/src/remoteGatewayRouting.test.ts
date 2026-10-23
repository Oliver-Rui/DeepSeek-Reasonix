import { afterEach, describe, expect, it, vi } from "vitest";
import { World } from "./testing/world";
import { disconnectRemote, gatewayCallbackSecret, remoteDevicePresence } from "./remoteGateway";

const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const world = new World({ bindings: { REMOTE_GATEWAY_TOKEN: "hosted-secret" } });
  const account = await world.addAccount();
  const own = await world.call("POST", "/me/gateways", { cookie: account.cookie, body: { label: "home", origin: "https://relay.example.com" } });
  const mine = await world.call("POST", "/me/devices", {
    cookie: account.cookie, body: { name: "mine", platform: "linux", publicKey: key(), capabilities: ["tasks"], gatewayId: own.body.gateway.id },
  });
  const hosted = await world.addHost(account.id);
  return { world, account, own: own.body, mine: mine.body.device.id as string, hosted: hosted.id };
}

describe("calls to a device's own gateway", () => {
  it("sends status and revoke to each device's origin with that gateway's callback secret", async () => {
    const { world, own, mine, hosted } = await setup();
    const calls: Array<{ url: string; token: string; ids: string[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { deviceIds: string[] };
      calls.push({ url, token: (init.headers as Record<string, string>)["x-reasonix-gateway-token"]!, ids: body.deviceIds });
      return Response.json({ ok: true, devices: body.deviceIds.map((id) => ({ id, online: true })) });
    }));

    const presence = await remoteDevicePresence(world.env, [mine, hosted]);
    expect(presence.available).toBe(true);
    expect([...presence.onlineIds].sort()).toEqual([mine, hosted].sort());
    const own_ = calls.find((call) => call.url.startsWith("https://relay.example.com"))!;
    const hosted_ = calls.find((call) => call.url.startsWith("https://remote.reasonix.io"))!;
    expect(own_.ids).toEqual([mine]);
    expect(hosted_.ids).toEqual([hosted]);
    expect(own_.token).toBe(await gatewayCallbackSecret("pepper", own.gateway.id));
    expect(own_.token).toBe(own.callbackSecret);
    expect(own_.token).not.toBe(own.token);
    expect(hosted_.token).toBe("hosted-secret");

    calls.length = 0;
    await expect(disconnectRemote(world.env, [mine, hosted])).resolves.toBe(true);
    expect(calls.map((call) => call.url).sort()).toEqual(["https://relay.example.com/v1/devices/revoke", "https://remote.reasonix.io/v1/devices/revoke"]);
  });

  it("does not follow a redirect and reports the device as unavailable", async () => {
    const { world, mine } = await setup();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const presence = await remoteDevicePresence(world.env, [mine]);
    expect(presence).toEqual({ onlineIds: new Set(), available: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not trust a presence answer for a device it did not ask about", async () => {
    const { world, mine, hosted } = await setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({
      devices: [{ id: url.startsWith("https://relay.example.com") ? hosted : mine, online: true }],
    })));
    const presence = await remoteDevicePresence(world.env, [mine, hosted]);
    expect(presence.onlineIds.size).toBe(0);
  });

  it("still reaches the origin of a removed gateway, so its connections can be closed", async () => {
    const { world, account, own, mine } = await setup();
    await world.call("DELETE", `/me/gateways/${own.gateway.id}`, { cookie: account.cookie });
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(disconnectRemote(world.env, [mine])).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://relay.example.com/v1/devices/revoke", expect.anything());
  });

  it("names the relay in a connection grant, and null for a hosted device", async () => {
    const { world, account, mine, hosted } = await setup();
    const own = await world.call("POST", "/me/remote-grants", { cookie: account.cookie, body: { targetDeviceId: mine, scopes: ["tasks"] } });
    expect(own.status).toBe(201);
    expect(own.body.relay).toBe("https://relay.example.com");
    const hostedGrant = await world.call("POST", "/me/remote-grants", { cookie: account.cookie, body: { targetDeviceId: hosted, scopes: ["tasks"] } });
    expect(hostedGrant.body.relay).toBeNull();
  });
});
