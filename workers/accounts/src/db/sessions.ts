import type { UserRow } from "../types";
import { generateToken, hashToken } from "../auth/crypto";
import { CLI_SESSION_MAX_AGE_MS, CLI_SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from "../config";

export interface NewSession {
  kind?: "web" | "cli";
  userAgent?: string;
  ttlMs?: number;
}

export interface SessionRef {
  id: string;
  kind: "web" | "cli";
  createdAt: string;
}

export interface ResolvedSession {
  user: UserRow;
  session: SessionRef;
}

export class SessionRepo {
  constructor(
    private readonly db: D1Database,
    private readonly pepper: string,
  ) {}

  // Persists sha256(pepper:token) and returns the raw token for the cookie.
  async create(userId: number, opts: NewSession = {}): Promise<string> {
    const token = generateToken();
    const tokenHash = await hashToken(this.pepper, token);
    const now = new Date();
    const expires = new Date(now.getTime() + (opts.ttlMs ?? SESSION_TTL_MS));
    await this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, kind, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
      )
      .bind(tokenHash, userId, opts.kind ?? "web", (opts.userAgent ?? "").slice(0, 256), now.toISOString(), expires.toISOString())
      .run();
    return token;
  }

  // Resolves a cookie token to its active user, pruning the row if expired.
  async resolve(token: string): Promise<UserRow | null> {
    return (await this.resolveSession(token))?.user ?? null;
  }

  // The session's id is its stored hash, so it can name the session to another
  // service without ever being usable as a cookie.
  async resolveSession(token: string): Promise<ResolvedSession | null> {
    const tokenHash = await hashToken(this.pepper, token);
    const row = await this.db
      .prepare(
        `SELECT u.*, s.expires_at AS s_expires, s.created_at AS s_created, s.kind AS s_kind
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?1`,
      )
      .bind(tokenHash)
      .first<UserRow & { s_expires: string; s_created: string; s_kind: string }>();
    if (!row) return null;
    if (row.s_expires <= new Date().toISOString()) {
      await this.deleteByHash(tokenHash);
      return null;
    }
    if (row.status !== "active") return null;
    if (row.s_kind === "cli") await this.renew(tokenHash, row.s_created, row.s_expires);
    const { s_expires: _ignored, s_created: createdAt, s_kind: kind, ...user } = row;
    return { user, session: { id: tokenHash, kind: kind === "cli" ? "cli" : "web", createdAt } };
  }

  // A command-line session in use is extended by a full term, at most once a
  // day, and never past its maximum age. A failed write leaves the session as
  // it was: it is still valid, and the next use tries again.
  private async renew(tokenHash: string, createdAt: string, expiresAt: string): Promise<void> {
    const now = Date.now();
    if (Date.parse(expiresAt) - now > SESSION_TTL_MS - CLI_SESSION_RENEW_AFTER_MS) return;
    const next = Math.min(now + SESSION_TTL_MS, Date.parse(createdAt) + CLI_SESSION_MAX_AGE_MS);
    if (!(next > Date.parse(expiresAt))) return;
    try {
      await this.db.prepare("UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE token_hash = ?3 AND kind = 'cli'")
        .bind(new Date(next).toISOString(), new Date(now).toISOString(), tokenHash).run();
    } catch {
      // keep the existing term
    }
  }

  async deleteByToken(token: string): Promise<void> {
    await this.deleteByHash(await hashToken(this.pepper, token));
  }

  async deleteAllForUser(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
  }

  private async deleteByHash(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
  }
}
