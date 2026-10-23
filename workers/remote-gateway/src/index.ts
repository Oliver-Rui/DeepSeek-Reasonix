import {
  authenticateDevice,
  authorizeAttachmentDownload,
  authorizeAttachmentUpload,
  bearerToken,
  consumeGrant,
} from "./accounts";
import type { Env } from "./env";
import {
  offeredProtocols,
  REMOTE_AUTH_PROTOCOL_PREFIX,
  REMOTE_WEBSOCKET_PROTOCOL,
} from "./protocol";
import { coarseHash, trace } from "./trace";
export { RemoteSession } from "./session";

const DEVICE_PATH = /^\/v1\/devices\/([0-9a-f]{64})\/connect$/;
const ATTACHMENT_PATH = /^\/v1\/attachments\/([0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PRESENCE_DEVICES = 50;

function equalSecret(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

// The account service's calls (device status, revocation) carry
// ACCOUNT_CALLBACK_TOKEN when this gateway has one. The hosted gateway has none
// and keeps using the one shared secret both ways; a self-hosted gateway has a
// separate secret in each direction, so the token it presents to the account
// service cannot be used to call it back.
function gatewayAuthenticated(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-reasonix-gateway-token") ?? "";
  const expected = env.ACCOUNT_CALLBACK_TOKEN || env.REMOTE_GATEWAY_TOKEN;
  return Boolean(expected) && equalSecret(supplied, expected ?? "");
}

// The account service calls this right after revoking a device or ending a
// session, so live connections close now rather than at their next check.
async function revokeDevices(request: Request, env: Env): Promise<Response> {
  let body: { deviceIds?: unknown; sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "A JSON body is required.");
  }
  const deviceIds = body.deviceIds;
  if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > MAX_PRESENCE_DEVICES ||
      deviceIds.some((id) => typeof id !== "string" || !SHA256_PATTERN.test(id))) {
    return jsonError(400, "invalid_devices", `Up to ${MAX_PRESENCE_DEVICES} valid device IDs are allowed.`);
  }
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !SHA256_PATTERN.test(body.sessionId))) {
    return jsonError(400, "invalid_session", "The session ID is invalid.");
  }
  const payload = JSON.stringify(body.sessionId ? { sessionId: body.sessionId } : {});
  const results = await Promise.all([...new Set(deviceIds as string[])].map(async (deviceId) => {
    try {
      const stub = env.REMOTE_SESSIONS.get(env.REMOTE_SESSIONS.idFromName(deviceId));
      const response = await stub.fetch("https://session.internal/revoke", { method: "POST", body: payload });
      return response.ok;
    } catch {
      return false;
    }
  }));
  if (results.includes(false)) return jsonError(502, "revoke_incomplete", "Some devices could not be reached.");
  return Response.json({ ok: true });
}

function attachmentKey(objectId: string): string {
  return `encrypted/${objectId}`;
}

async function putAttachment(request: Request, env: Env, objectId: string, ticket: string): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length"));
  const ciphertextSha256 = request.headers.get("x-reasonix-ciphertext-sha256")?.toLowerCase() ?? "";
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || !SHA256_PATTERN.test(ciphertextSha256)) {
    return jsonError(400, "invalid_attachment", "A content length and ciphertext SHA-256 are required.");
  }
  const authorized = await authorizeAttachmentUpload(env, {
    objectId,
    ticket,
    ciphertextBytes: contentLength,
    ciphertextSha256,
  });
  if (!authorized || authorized.attachment.objectId !== objectId) {
    return jsonError(401, "invalid_attachment_grant", "The upload grant is invalid or expired.");
  }
  if (contentLength > authorized.attachment.maxBytes || !request.body) {
    return jsonError(413, "attachment_too_large", "The encrypted attachment exceeds its grant.");
  }
  try {
    await env.ATTACHMENTS.put(attachmentKey(objectId), request.body, {
      httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment" },
      customMetadata: { expiresAt: authorized.attachment.expiresAt },
      sha256: ciphertextSha256,
    });
  } catch {
    return jsonError(422, "ciphertext_mismatch", "The encrypted attachment did not match its declared hash.");
  }
  return Response.json({ attachment: { objectId, ciphertextBytes: contentLength, ciphertextSha256 } }, { status: 201 });
}

async function getAttachment(env: Env, objectId: string, ticket: string): Promise<Response> {
  const authorized = await authorizeAttachmentDownload(env, objectId, ticket);
  if (!authorized || authorized.attachment.objectId !== objectId) {
    return jsonError(401, "invalid_attachment_grant", "The download grant is invalid or expired.");
  }
  const object = await env.ATTACHMENTS.get(attachmentKey(objectId));
  if (!object || object.size !== authorized.attachment.ciphertextBytes) {
    return jsonError(404, "attachment_unavailable", "The encrypted attachment is unavailable.");
  }
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": "attachment",
      "content-length": String(object.size),
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "x-reasonix-ciphertext-sha256": authorized.attachment.ciphertextSha256,
    },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function routeOf(pathname: string): string {
  if (DEVICE_PATH.test(pathname)) return "device";
  if (pathname === "/v1/sessions/connect") return "controller";
  if (pathname === "/v1/probe") return "probe";
  if (ATTACHMENT_PATH.test(pathname)) return "attachment";
  if (pathname.startsWith("/v1/devices/")) return "admin";
  return "other";
}

// `hashed` is a device id, or the grant token for rate_limited and invalid_grant;
// only its 32-bit hash is logged.
function refuseHandshake(
  request: Request,
  status: number,
  code: string,
  message: string,
  hashed?: string,
): Response {
  trace("handshake_rejected", {
    code,
    status,
    path: routeOf(new URL(request.url).pathname),
    origin: requestOrigin(request)?.slice(0, 80) ?? null,
    subject: hashed ? coarseHash(hashed) : null,
  });
  return jsonError(status, code, message);
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin")?.trim();
  return origin || null;
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = requestOrigin(request);
  if (!origin) return true;
  return env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).includes(origin);
}

function withAttachmentCors(request: Request, response: Response): Response {
  const origin = requestOrigin(request);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "content-length,x-reasonix-ciphertext-sha256");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function withinBudget(request: Request, env: Env, token: string): Promise<boolean> {
  if (!env.GATEWAY_LIMITER) return true;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return (await env.GATEWAY_LIMITER.limit({ key: `${ip}:${token.slice(0, 16)}` })).success;
}

interface Admission {
  role: "device" | "controller";
  admittedAt: number;
  userId: number;
  scopes: string[];
  sessionId?: string;
  reauthAt?: number;
}

function forwardToSession(
  request: Request,
  env: Env,
  targetDeviceId: string,
  admission: Admission,
): Promise<Response> {
  const id = env.REMOTE_SESSIONS.idFromName(targetDeviceId);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!name.startsWith("x-reasonix-") && name !== "authorization") headers.append(name, value);
  }
  headers.set("x-reasonix-role", admission.role);
  headers.set("x-reasonix-user-id", String(admission.userId));
  headers.set("x-reasonix-device-id", targetDeviceId);
  headers.set("x-reasonix-scopes", admission.scopes.join(","));
  headers.set("x-reasonix-admitted-at", String(admission.admittedAt));
  if (admission.sessionId) headers.set("x-reasonix-session", admission.sessionId);
  if (admission.reauthAt !== undefined) headers.set("x-reasonix-reauth-at", String(admission.reauthAt));
  const protocols = offeredProtocols(request);
  if (protocols.includes(REMOTE_WEBSOCKET_PROTOCOL)) {
    headers.set("sec-websocket-protocol", REMOTE_WEBSOCKET_PROTOCOL);
  } else {
    headers.delete("sec-websocket-protocol");
  }
  return env.REMOTE_SESSIONS.get(id).fetch(new Request(request, { headers }));
}

function connectionToken(request: Request): string | null {
  const headerToken = bearerToken(request);
  if (headerToken) return headerToken;
  const protocols = offeredProtocols(request);
  if (!protocols.includes(REMOTE_WEBSOCKET_PROTOCOL)) return null;
  const tickets = protocols
    .filter((value) => value.startsWith(REMOTE_AUTH_PROTOCOL_PREFIX))
    .map((value) => value.slice(REMOTE_AUTH_PROTOCOL_PREFIX.length));
  if (tickets.length !== 1 || !SHA256_PATTERN.test(tickets[0] ?? "")) return null;
  return tickets[0] ?? null;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "reasonix-remote-gateway" });
    }
    if (!originAllowed(request, env)) {
      const refused = refuseHandshake(request, 403, "origin_rejected", "This website is not allowed to use the remote gateway.");
      refused.headers.set("access-control-allow-origin", "*");
      refused.headers.set("cache-control", "no-store");
      return refused;
    }
    if (url.pathname === "/v1/probe" && request.method === "GET") {
      return withAttachmentCors(request, Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }));
    }
    if (url.pathname === "/v1/devices/revoke" && request.method === "POST") {
      if (!gatewayAuthenticated(request, env)) {
        return jsonError(401, "unauthorized_gateway", "Gateway authentication failed.");
      }
      return revokeDevices(request, env);
    }
    if (url.pathname === "/v1/devices/status" && request.method === "POST") {
      if (!gatewayAuthenticated(request, env)) {
        return jsonError(401, "unauthorized_gateway", "Gateway authentication failed.");
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonError(400, "invalid_request", "A JSON body is required.");
      }
      const candidate = body as { deviceIds?: unknown };
      if (!Array.isArray(candidate.deviceIds) || candidate.deviceIds.length > MAX_PRESENCE_DEVICES ||
          candidate.deviceIds.some((id) => typeof id !== "string" || !SHA256_PATTERN.test(id))) {
        return jsonError(400, "invalid_devices", `Up to ${MAX_PRESENCE_DEVICES} valid device IDs are allowed.`);
      }
      const uniqueIds = [...new Set(candidate.deviceIds as string[])];
      const devices = await Promise.all(uniqueIds.map(async (deviceId) => {
        const id = env.REMOTE_SESSIONS.idFromName(deviceId);
        try {
          const response = await env.REMOTE_SESSIONS.get(id).fetch("https://session.internal/status");
          const status = response.ok ? await response.json<{ online?: boolean }>() : null;
          return { id: deviceId, online: status?.online === true };
        } catch {
          return { id: deviceId, online: false };
        }
      }));
      return Response.json({ devices });
    }
    const attachmentMatch = ATTACHMENT_PATH.exec(url.pathname);
    if (attachmentMatch?.[1] && request.method === "OPTIONS") {
      return withAttachmentCors(request, new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-headers": "authorization,content-type,x-reasonix-ciphertext-sha256",
          "access-control-allow-methods": "GET,PUT,OPTIONS",
          "access-control-max-age": "600",
        },
      }));
    }
    if (attachmentMatch?.[1] && (request.method === "PUT" || request.method === "GET")) {
      const ticket = bearerToken(request);
      if (!ticket) return jsonError(401, "invalid_token", "A valid attachment grant is required.");
      if (!(await withinBudget(request, env, ticket))) {
        return jsonError(429, "rate_limited", "Too many attachment requests.");
      }
      const response = await (request.method === "PUT"
        ? putAttachment(request, env, attachmentMatch[1], ticket)
        : getAttachment(env, attachmentMatch[1], ticket));
      return withAttachmentCors(request, response);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return refuseHandshake(request, 426, "upgrade_required", "A WebSocket connection is required.");
    }
    const token = connectionToken(request);
    if (!token) return refuseHandshake(request, 401, "invalid_token", "A valid connection credential is required.");
    if (!(await withinBudget(request, env, token))) {
      return refuseHandshake(request, 429, "rate_limited", "Too many connection attempts.", token);
    }

    // Taken before the account service answers, so a revocation that lands
    // while it is answering is newer than this admission.
    const admittedAt = Date.now();
    const deviceMatch = DEVICE_PATH.exec(url.pathname);
    if (deviceMatch?.[1]) {
      const authenticated = await authenticateDevice(env, deviceMatch[1], token);
      if (!authenticated || authenticated.device.id !== deviceMatch[1]) {
        return refuseHandshake(request, 401, "invalid_device", "The device credential is invalid or revoked.", deviceMatch[1]);
      }
      return forwardToSession(request, env, authenticated.device.id, {
        role: "device",
        admittedAt,
        userId: authenticated.userId,
        scopes: authenticated.device.capabilities,
      });
    }

    if (url.pathname === "/v1/sessions/connect") {
      const consumed = await consumeGrant(env, token);
      if (!consumed) return refuseHandshake(request, 401, "invalid_grant", "The connection grant is invalid or expired.", token);
      const reauthAt = Date.parse(consumed.grant.reauthAt ?? "");
      if (!Number.isSafeInteger(reauthAt) || reauthAt <= Date.now()) {
        return refuseHandshake(
          request, 401, "reauth_required", "Sign in again to control this computer remotely.", consumed.grant.targetDeviceId,
        );
      }
      return forwardToSession(request, env, consumed.grant.targetDeviceId, {
        role: "controller",
        admittedAt,
        userId: consumed.grant.userId,
        scopes: consumed.grant.scopes,
        sessionId: consumed.grant.sessionId,
        reauthAt,
      });
    }

    return jsonError(404, "not_found", "Not found.");
  },
};

export default worker;
