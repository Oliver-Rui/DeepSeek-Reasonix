import type { Bindings } from "./env";
import { normalizeGatewayOrigin } from "./db/remoteGateways";

const CALL_TIMEOUT_MS = 5000;

// The secret an account service call to a self-hosted gateway carries. It is
// derived, not stored, and differs from the token that gateway uses toward this
// service, so neither side's secret can be used as the other's.
export async function gatewayCallbackSecret(pepper: string, gatewayId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`gateway-callback:${gatewayId}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Target {
  origin: string;
  token: string;
  deviceIds: string[];
}

// Which gateway each device answers to. A device with no gateway is the hosted
// gateway's; so is one this lookup cannot place, which can only send a call to
// the hosted gateway (it will not know the device), never to anyone else's.
// The origin is checked again here: it is stored, but it is fetched from here.
async function targetsFor(env: Bindings, deviceIds: string[]): Promise<Target[]> {
  const groups = new Map<string, Target>();
  const placed = new Map<string, { gatewayId: string; origin: string }>();
  for (let at = 0; at < deviceIds.length; at += 50) {
    const batch = deviceIds.slice(at, at + 50);
    try {
      const rows = await env.DB.prepare(
        `SELECT d.id AS id, g.id AS gateway_id, g.origin AS origin
         FROM remote_devices d JOIN remote_gateways g ON g.id = d.gateway_id
         WHERE d.id IN (${batch.map((_, index) => `?${index + 1}`).join(",")})`,
      ).bind(...batch).all<{ id: string; gateway_id: string; origin: string }>();
      for (const row of rows.results) placed.set(row.id, { gatewayId: row.gateway_id, origin: row.origin });
    } catch {
      // unplaced devices fall through to the hosted gateway
    }
  }
  for (const id of deviceIds) {
    const own = placed.get(id);
    let key = "hosted";
    let origin = (env.REMOTE_GATEWAY_ORIGIN ?? "").replace(/\/+$/, "");
    let token = env.REMOTE_GATEWAY_TOKEN ?? "";
    if (own) {
      const safe = normalizeGatewayOrigin(own.origin);
      if (!safe) continue;
      key = own.gatewayId;
      origin = safe;
      token = await gatewayCallbackSecret(env.SESSION_PEPPER ?? "", own.gatewayId);
    }
    if (!origin || !token) continue;
    const group = groups.get(key) ?? { origin, token, deviceIds: [] };
    group.deviceIds.push(id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// A gateway answers or it does not: no redirects (a registered origin must not
// be able to bounce this service elsewhere) and a short timeout.
function callGateway(target: Target, path: string, body: unknown): Promise<Response> {
  return fetch(`${target.origin}${path}`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-reasonix-gateway-token": target.token },
    body: JSON.stringify(body),
  });
}

export async function remoteDevicePresence(
  env: Bindings,
  deviceIds: string[],
): Promise<{ onlineIds: Set<string>; available: boolean }> {
  if (deviceIds.length === 0) return { onlineIds: new Set(), available: true };
  const targets = await targetsFor(env, deviceIds.slice(0, 50));
  const onlineIds = new Set<string>();
  let available = targets.length > 0 && targets.reduce((count, target) => count + target.deviceIds.length, 0) === Math.min(deviceIds.length, 50);
  await Promise.all(targets.map(async (target) => {
    try {
      const response = await callGateway(target, "/v1/devices/status", { deviceIds: target.deviceIds });
      if (!response.ok) {
        available = false;
        return;
      }
      const data = await response.json<{ devices?: Array<{ id?: string; online?: boolean }> }>();
      for (const device of data.devices ?? []) {
        if (device.online === true && typeof device.id === "string" && target.deviceIds.includes(device.id)) onlineIds.add(device.id);
      }
    } catch {
      available = false;
    }
  }));
  return { onlineIds, available };
}

// Asks each device's gateway to close live connections the account service has
// just revoked. With `sessionId`, only controllers admitted through that account
// session close; without it, every connection to the named devices does.
// The gateways also re-check each connection on a timer, so a failed call here
// delays the disconnect rather than losing it.
export async function disconnectRemote(
  env: Bindings,
  deviceIds: string[],
  sessionId?: string,
): Promise<boolean> {
  if (deviceIds.length === 0) return true;
  const targets = await targetsFor(env, deviceIds);
  if (targets.reduce((count, target) => count + target.deviceIds.length, 0) !== deviceIds.length) return false;
  let delivered = true;
  for (const target of targets) {
    for (let at = 0; at < target.deviceIds.length; at += 50) {
      const batch = target.deviceIds.slice(at, at + 50);
      const body = sessionId ? { deviceIds: batch, sessionId } : { deviceIds: batch };
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          ok = (await callGateway(target, "/v1/devices/revoke", body)).ok;
        } catch {
          ok = false;
        }
      }
      delivered &&= ok;
    }
  }
  return delivered;
}
