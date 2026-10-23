import { generateToken, hashToken } from "../auth/crypto";

export const MAX_GATEWAYS_PER_USER = 3;

interface GatewayRow {
  id: string;
  user_id: number;
  label: string;
  origin: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface RemoteGateway {
  id: string;
  label: string;
  origin: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const COLUMNS = "id, user_id, label, origin, created_at, last_used_at, revoked_at";

function toGateway(row: GatewayRow): RemoteGateway {
  return { id: row.id, label: row.label, origin: row.origin, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}

// The origin is fetched by this service (device status and revocation), so it
// is held to what a public gateway looks like: https, a DNS name, no
// credentials, no path, and nothing that names this machine or a private
// network. Returns the normalized origin, or null.
export function normalizeGatewayOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/.test(host)) return null;
  return `https://${host}${url.port && url.port !== "443" ? `:${url.port}` : ""}`;
}

export class RemoteGatewayRepo {
  constructor(
    private readonly db: D1Database,
    private readonly pepper: string,
  ) {}

  async register(input: { userId: number; label: string; origin: string }): Promise<{ gateway: RemoteGateway; token: string } | "limit" | "exists"> {
    const active = await this.db.prepare(
      "SELECT COUNT(*) AS n FROM remote_gateways WHERE user_id = ?1 AND revoked_at IS NULL",
    ).bind(input.userId).first<{ n: number }>();
    if ((active?.n ?? 0) >= MAX_GATEWAYS_PER_USER) return "limit";
    const taken = await this.db.prepare(
      "SELECT 1 AS ok FROM remote_gateways WHERE user_id = ?1 AND origin = ?2 AND revoked_at IS NULL",
    ).bind(input.userId, input.origin).first<{ ok: number }>();
    if (taken) return "exists";
    const token = generateToken();
    const now = new Date().toISOString();
    const row = await this.db.prepare(
      `INSERT INTO remote_gateways (id, user_id, label, origin, token_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id, origin) DO UPDATE SET
         label = excluded.label, token_hash = excluded.token_hash, created_at = excluded.created_at,
         last_used_at = NULL, revoked_at = NULL
       RETURNING ${COLUMNS}`,
    ).bind(generateToken(), input.userId, input.label, input.origin, await hashToken(this.pepper, token), now).first<GatewayRow>();
    if (!row) throw new Error("gateway registration returned no row");
    return { gateway: toGateway(row), token };
  }

  async listForUser(userId: number): Promise<RemoteGateway[]> {
    const result = await this.db.prepare(
      `SELECT ${COLUMNS} FROM remote_gateways WHERE user_id = ?1 ORDER BY revoked_at IS NULL DESC, created_at DESC`,
    ).bind(userId).all<GatewayRow>();
    return result.results.map(toGateway);
  }

  async activeForUser(userId: number, gatewayId: string): Promise<RemoteGateway | null> {
    const row = await this.db.prepare(
      `SELECT ${COLUMNS} FROM remote_gateways WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
    ).bind(gatewayId, userId).first<GatewayRow>();
    return row ? toGateway(row) : null;
  }

  // Revoking the gateway also revokes the devices bound to it: they can only
  // be reached through it, and a token that no longer works must not leave
  // devices that look registered.
  async revoke(userId: number, gatewayId: string): Promise<{ deviceIds: string[] } | null> {
    const now = new Date().toISOString();
    const [gateway, devices] = await this.db.batch<{ id: string }>([
      this.db.prepare(
        "UPDATE remote_gateways SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL RETURNING id",
      ).bind(now, gatewayId, userId),
      this.db.prepare(
        `UPDATE remote_devices SET revoked_at = ?1, updated_at = ?1
         WHERE gateway_id = ?2 AND user_id = ?3 AND revoked_at IS NULL RETURNING id`,
      ).bind(now, gatewayId, userId),
    ]);
    if (!gateway || gateway.results.length === 0) return null;
    return { deviceIds: (devices?.results ?? []).map((row) => row.id) };
  }

  // The gateway a presented token belongs to, if it is registered and live.
  async authenticate(token: string): Promise<{ id: string; userId: number; origin: string } | null> {
    const row = await this.db.prepare(
      `UPDATE remote_gateways SET last_used_at = ?1
       WHERE token_hash = ?2 AND revoked_at IS NULL RETURNING id, user_id, origin`,
    ).bind(new Date().toISOString(), await hashToken(this.pepper, token)).first<{ id: string; user_id: number; origin: string }>();
    return row ? { id: row.id, userId: row.user_id, origin: row.origin } : null;
  }
}
