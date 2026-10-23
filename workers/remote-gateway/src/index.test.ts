import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./env";
import { resetTrace } from "./trace";

interface ForwardedRequest {
  id: string;
  request: Request;
}

function environment(forwarded: ForwardedRequest[], attachments?: Record<string, unknown>): Env {
  return {
    ACCOUNT_ORIGIN: "https://id.reasonix.io",
    ALLOWED_ORIGINS: "https://reasonix.io,https://www.reasonix.io",
    REMOTE_GATEWAY_TOKEN: "gateway-secret",
    GATEWAY_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ATTACHMENTS: {
      put: vi.fn(async () => ({} as R2Object)),
      get: vi.fn(async () => null),
      ...attachments,
    } as unknown as R2Bucket,
    REMOTE_SESSIONS: {
      idFromName(name: string) { return name as unknown as DurableObjectId; },
      get(id: DurableObjectId) {
        return {
          async fetch(input: RequestInfo, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init);
            forwarded.push({ id: id as unknown as string, request });
            return new Response("forwarded");
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
  };
}

function websocketRequest(path: string, token: string): Request {
  return new Request(`https://remote.reasonix.io${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      upgrade: "websocket",
      "cf-connecting-ip": "203.0.113.10",
    },
  });
}

function browserWebsocketRequest(path: string, token: string): Request {
  return new Request(`https://remote.reasonix.io${path}`, {
    headers: {
      origin: "https://reasonix.io",
      upgrade: "websocket",
      "cf-connecting-ip": "203.0.113.10",
      "sec-websocket-protocol": `reasonix.remote.v1, reasonix.auth.${token}`,
    },
  });
}

function run(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(worker.fetch!(request as never, env, {} as ExecutionContext));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTrace();
});

describe("remote gateway admission", () => {
  it("serves health without opening a session", async () => {
    const response = await run(new Request("https://remote.reasonix.io/health"), environment([]));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "reasonix-remote-gateway" });
  });

  it("reports live device presence only to the account service", async () => {
    const forwarded: ForwardedRequest[] = [];
    const first = "1".repeat(64);
    const second = "2".repeat(64);
    const env = environment(forwarded);
    env.REMOTE_SESSIONS = {
      idFromName(name: string) { return name as unknown as DurableObjectId; },
      get(id: DurableObjectId) {
        return {
          fetch: vi.fn(async () => Response.json({ online: id as unknown as string === first })),
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;

    const response = await run(new Request("https://remote.reasonix.io/v1/devices/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reasonix-gateway-token": "gateway-secret",
      },
      body: JSON.stringify({ deviceIds: [first, second] }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ devices: [
      { id: first, online: true },
      { id: second, online: false },
    ] });
  });

  it("does not expose device presence without the gateway secret", async () => {
    const response = await run(new Request("https://remote.reasonix.io/v1/devices/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceIds: ["1".repeat(64)] }),
    }), environment([]));
    expect(response.status).toBe(401);
  });

  it("authenticates a device and strips its credential before Durable Object admission", async () => {
    const forwarded: ForwardedRequest[] = [];
    const deviceId = "a".repeat(64);
    const credential = "b".repeat(64);
    const accountFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      userId: 7,
      device: { id: deviceId, publicKey: "A".repeat(43), capabilities: ["terminal", "logs"] },
    }));
    vi.stubGlobal("fetch", accountFetch);

    const response = await run(
      websocketRequest(`/v1/devices/${deviceId}/connect`, credential),
      environment(forwarded),
    );

    expect(response.status).toBe(200);
    expect(accountFetch).toHaveBeenCalledOnce();
    const accountRequest = accountFetch.mock.calls[0]?.[1];
    expect(accountRequest?.headers).toMatchObject({ "x-reasonix-gateway-token": "gateway-secret" });
    expect(forwarded[0]?.id).toBe(deviceId);
    expect(forwarded[0]?.request.headers.get("authorization")).toBeNull();
    expect(forwarded[0]?.request.headers.get("x-reasonix-role")).toBe("device");
    expect(forwarded[0]?.request.headers.get("x-reasonix-device-id")).toBe(deviceId);
    expect(Number(forwarded[0]?.request.headers.get("x-reasonix-admitted-at"))).toBeLessThanOrEqual(Date.now());
    expect(forwarded[0]?.request.headers.get("x-reasonix-reauth-at")).toBeNull();
  });

  it("consumes a controller grant and routes it to the target device room", async () => {
    const forwarded: ForwardedRequest[] = [];
    const targetDeviceId = "c".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      grant: { userId: 9, targetDeviceId, scopes: ["terminal"], reauthAt: new Date(Date.now() + 60_000).toISOString() },
    })));

    const response = await run(
      websocketRequest("/v1/sessions/connect", "d".repeat(64)),
      environment(forwarded),
    );

    expect(response.status).toBe(200);
    expect(forwarded[0]?.id).toBe(targetDeviceId);
    expect(forwarded[0]?.request.headers.get("x-reasonix-role")).toBe("controller");
    expect(forwarded[0]?.request.headers.get("x-reasonix-scopes")).toBe("terminal");
    expect(Number(forwarded[0]?.request.headers.get("x-reasonix-reauth-at"))).toBeGreaterThan(Date.now());
  });

  it("refuses a grant that does not say when its session must sign in again", async () => {
    const forwarded: ForwardedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      grant: { userId: 9, targetDeviceId: "c".repeat(64), scopes: ["desktop"] },
    })));
    const response = await run(websocketRequest("/v1/sessions/connect", "d".repeat(64)), environment(forwarded));
    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("carries the signing-in session and its re-authentication time, never a client's copy", async () => {
    const forwarded: ForwardedRequest[] = [];
    const targetDeviceId = "c".repeat(64);
    const reauthAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      grant: { userId: 9, targetDeviceId, scopes: ["desktop"], sessionId: "5".repeat(64), reauthAt },
    })));
    const request = websocketRequest("/v1/sessions/connect", "d".repeat(64));
    const forged = new Headers(request.headers);
    forged.set("x-reasonix-reauth-at", String(Number.MAX_SAFE_INTEGER));
    forged.set("x-reasonix-role", "device");

    await run(new Request(request, { headers: forged }), environment(forwarded));

    const headers = forwarded[0]?.request.headers;
    expect(headers?.get("x-reasonix-role")).toBe("controller");
    expect(headers?.get("x-reasonix-session")).toBe("5".repeat(64));
    expect(Number(headers?.get("x-reasonix-reauth-at"))).toBe(Date.parse(reauthAt));
  });

  it("closes a revoked device's connections only for the account service", async () => {
    const forwarded: ForwardedRequest[] = [];
    const deviceId = "a".repeat(64);
    const denied = await run(new Request("https://remote.reasonix.io/v1/devices/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceIds: [deviceId] }),
    }), environment(forwarded));
    expect(denied.status).toBe(401);
    expect(forwarded).toHaveLength(0);

    const env = environment(forwarded);
    const response = await run(new Request("https://remote.reasonix.io/v1/devices/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-reasonix-gateway-token": "gateway-secret" },
      body: JSON.stringify({ deviceIds: [deviceId], sessionId: "6".repeat(64) }),
    }), env);
    expect(response.status).toBe(200);
    expect(forwarded[0]?.id).toBe(deviceId);
    expect(new URL(forwarded[0]!.request.url).pathname).toBe("/revoke");
    await expect(forwarded[0]!.request.json()).resolves.toEqual({ sessionId: "6".repeat(64) });
  });

  it("answers the account service's calls with ACCOUNT_CALLBACK_TOKEN when one is set, and not with the token it presents to the account service", async () => {
    const forwarded: ForwardedRequest[] = [];
    const deviceId = "4".repeat(64);
    const call = (token: string) => run(new Request("https://remote.reasonix.io/v1/devices/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-reasonix-gateway-token": token },
      body: JSON.stringify({ deviceIds: [deviceId] }),
    }), { ...environment(forwarded), ACCOUNT_CALLBACK_TOKEN: "callback-secret" });
    expect((await call("gateway-secret")).status).toBe(401);
    expect((await call("callback-secret")).status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  it("admits a browser controller without exposing its ticket to the session", async () => {
    const forwarded: ForwardedRequest[] = [];
    const targetDeviceId = "e".repeat(64);
    const ticket = "f".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      grant: { userId: 11, targetDeviceId, scopes: ["tasks"], reauthAt: new Date(Date.now() + 60_000).toISOString() },
    })));

    const response = await run(
      browserWebsocketRequest("/v1/sessions/connect", ticket),
      environment(forwarded),
    );

    expect(response.status).toBe(200);
    expect(forwarded[0]?.request.headers.get("authorization")).toBeNull();
    expect(forwarded[0]?.request.headers.get("sec-websocket-protocol")).toBe("reasonix.remote.v1");
    expect([...forwarded[0]?.request.headers.values() ?? []].join(" ")).not.toContain(ticket);
  });

  it("rejects a browser ticket without the versioned remote protocol", async () => {
    const accountFetch = vi.fn();
    vi.stubGlobal("fetch", accountFetch);
    const response = await run(new Request("https://remote.reasonix.io/v1/sessions/connect", {
      headers: {
        origin: "https://reasonix.io",
        upgrade: "websocket",
        "sec-websocket-protocol": `reasonix.auth.${"a".repeat(64)}`,
      },
    }), environment([]));

    expect(response.status).toBe(401);
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed credentials before contacting the account service", async () => {
    const accountFetch = vi.fn();
    vi.stubGlobal("fetch", accountFetch);
    const response = await run(
      websocketRequest("/v1/sessions/connect", "short"),
      environment([]),
    );
    expect(response.status).toBe(401);
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it("rejects browser requests from websites outside the allowlist", async () => {
    const accountFetch = vi.fn();
    vi.stubGlobal("fetch", accountFetch);
    const response = await run(new Request(`https://remote.reasonix.io/v1/attachments/${"a".repeat(64)}`, {
      headers: {
        authorization: `Bearer ${"b".repeat(64)}`,
        origin: "https://attacker.example",
      },
    }), environment([]));

    expect(response.status).toBe(403);
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it("answers attachment preflight only for an allowed website", async () => {
    const response = await run(new Request(`https://remote.reasonix.io/v1/attachments/${"a".repeat(64)}`, {
      method: "OPTIONS",
      headers: { origin: "https://reasonix.io" },
    }), environment([]));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://reasonix.io");
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("streams authorized ciphertext to R2 with hash enforcement", async () => {
    const objectId = "e".repeat(64);
    const ticket = "f".repeat(64);
    const hash = "a".repeat(64);
    const put = vi.fn(async (_key: string, _value: unknown, _options: R2PutOptions) => ({} as R2Object));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      attachment: {
        objectId,
        userId: 9,
        targetDeviceId: "b".repeat(64),
        maxBytes: 4,
        ciphertextBytes: 4,
        ciphertextSha256: hash,
        expiresAt: "2026-09-28T00:00:00.000Z",
      },
    })));

    const response = await run(new Request(`https://remote.reasonix.io/v1/attachments/${objectId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-length": "4",
        "x-reasonix-ciphertext-sha256": hash,
      },
      body: "data",
    }), environment([], { put }));

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe(`encrypted/${objectId}`);
    expect(put.mock.calls[0]?.[2]).toMatchObject({
      sha256: hash,
      httpMetadata: { contentType: "application/octet-stream" },
    });
  });

  it("downloads only authorized opaque bytes with browser sniffing disabled", async () => {
    const objectId = "1".repeat(64);
    const ticket = "2".repeat(64);
    const hash = "3".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      attachment: {
        objectId,
        userId: 9,
        targetDeviceId: "4".repeat(64),
        maxBytes: 6,
        ciphertextBytes: 6,
        ciphertextSha256: hash,
        expiresAt: "2026-09-28T00:00:00.000Z",
      },
    })));
    const get = vi.fn(async () => ({
      body: new Blob(["cipher"]),
      size: 6,
    }) as unknown as R2ObjectBody);

    const response = await run(new Request(`https://remote.reasonix.io/v1/attachments/${objectId}`, {
      headers: { authorization: `Bearer ${ticket}` },
    }), environment([], { get }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("cipher");
  });

  it("traces each refused handshake with its code and a hashed subject, never the credential", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { logged.push(line); });
    const ticket = "d".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    const invalid = await run(browserWebsocketRequest("/v1/sessions/connect", ticket), environment([]));
    const limited = environment([]);
    limited.GATEWAY_LIMITER = { limit: vi.fn(async () => ({ success: false })) };
    const throttled = await run(browserWebsocketRequest("/v1/sessions/connect", ticket), limited);
    const foreign = await run(new Request("https://remote.reasonix.io/v1/sessions/connect", {
      headers: { origin: "https://attacker.example", upgrade: "websocket" },
    }), environment([]));

    expect([invalid.status, throttled.status, foreign.status]).toEqual([401, 429, 403]);
    const events = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.code)).toEqual(["invalid_grant", "rate_limited", "origin_rejected"]);
    expect(events[0]).toMatchObject({ event: "handshake_rejected", status: 401, path: "controller", origin: "https://reasonix.io" });
    expect(events[0]?.subject).toMatch(/^[0-9a-f]{8}$/);
    expect(events[2]).toMatchObject({ origin: "https://attacker.example" });
    expect(logged.join("\n")).not.toContain(ticket);
  });

  it("lets a browser read whether its origin is allowed, and only that", async () => {
    const allowed = await run(new Request("https://remote.reasonix.io/v1/probe", {
      headers: { origin: "https://reasonix.io" },
    }), environment([]));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://reasonix.io");

    const refused = await run(new Request("https://remote.reasonix.io/v1/probe", {
      headers: { origin: "https://attacker.example" },
    }), environment([]));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "origin_rejected" } });
  });

  it("allows only origins that match the list exactly", async () => {
    const probe = (origin: string) => run(new Request("https://remote.reasonix.io/v1/probe", { headers: { origin } }), environment([]));
    for (const origin of [
      "https://reasonix.io.evil.com", "https://reasonix.io:8443", "https://REASONIX.IO", "https://reasonix.io.",
      "https://xn--reasonix-9ya.io", "null", "http://reasonix.io", "https://reasonix.io/",
    ]) {
      expect((await probe(origin)).status, origin).toBe(403);
    }
    expect((await probe("https://www.reasonix.io")).status).toBe(200);
  });

  it("answers the probe only to GET, per origin and uncached", async () => {
    const ok = await run(new Request("https://remote.reasonix.io/v1/probe", { headers: { origin: "https://reasonix.io" } }), environment([]));
    expect(ok.headers.get("vary")).toContain("Origin");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const refused = await run(new Request("https://remote.reasonix.io/v1/probe", { headers: { origin: "https://evil.example" } }), environment([]));
    expect(refused.headers.get("cache-control")).toBe("no-store");
    for (const method of ["HEAD", "POST", "PUT"]) {
      const response = await run(new Request("https://remote.reasonix.io/v1/probe", { method, headers: { origin: "https://reasonix.io" } }), environment([]));
      expect(response.status, method).not.toBe(200);
    }
  });
});
