import type { RemoteCapability } from "./env";

export const CONTROLLER_IDLE_MS = 30 * 60 * 1000;
export const DEVICE_IDLE_MS = 30 * 60 * 1000;
export const REVALIDATE_MS = 15 * 60 * 1000;
export const HEARTBEAT_MS = 20 * 1000;
// Re-checks may fail open while the account service is unreachable, but not for
// longer than this; then every connection has to be admitted again.
export const UNCHECKED_LIMIT_MS = 60 * 60 * 1000;
// A full room makes room only by closing a controller silent this long.
export const EVICTABLE_IDLE_MS = 60 * 1000;
export const SESSION_REVOCATION_TTL_MS = 15 * 60 * 1000;

export const HEARTBEAT_REQUEST = '{"type":"heartbeat"}';
export const HEARTBEAT_RESPONSE = '{"type":"heartbeat_ack"}';

// Close codes a client acts on. Idle and reconnect-worthy closes may be retried
// silently with a fresh grant; the other two need the user.
export const CLOSE_IDLE = 4408;
export const CLOSE_REAUTH_REQUIRED = 4401;
export const CLOSE_REVOKED = 4403;
export const CLOSE_DEVICE_REPLACED = 4001;
export const CLOSE_DISCONNECTED_BY_DEVICE = 4004;

export interface SocketLease {
  role: "device" | "controller";
  userId: number;
  deviceId: string;
  scopes: RemoteCapability[];
  connectionId: string | null;
  sessionId: string | null;
  admittedAt: number;
  lastActiveAt: number;
  reauthAt: number | null;
}

export type LeaseVerdict = "active" | "revoked" | "reauth_required";

export interface LeaseEnd {
  code: number;
  reason: string;
}

export function idleLimit(lease: SocketLease): number {
  return lease.role === "controller" ? CONTROLLER_IDLE_MS : DEVICE_IDLE_MS;
}

// A heartbeat the runtime answered without waking the object still counts.
export function lastActive(lease: SocketLease, autoResponseAt: Date | null): number {
  return Math.max(lease.lastActiveAt, autoResponseAt?.getTime() ?? 0);
}

export function leaseEnd(lease: SocketLease, now: number, autoResponseAt: Date | null): LeaseEnd | null {
  if (lease.reauthAt !== null && now >= lease.reauthAt) {
    return { code: CLOSE_REAUTH_REQUIRED, reason: "Sign-in required" };
  }
  if (now - lastActive(lease, autoResponseAt) >= idleLimit(lease)) {
    return { code: CLOSE_IDLE, reason: "Idle timeout" };
  }
  return null;
}

export function nextDeadline(lease: SocketLease, autoResponseAt: Date | null): number {
  const idle = lastActive(lease, autoResponseAt) + idleLimit(lease);
  return lease.reauthAt === null ? idle : Math.min(idle, lease.reauthAt);
}

export function verdictEnd(verdict: LeaseVerdict): LeaseEnd | null {
  if (verdict === "revoked") return { code: CLOSE_REVOKED, reason: "Access revoked" };
  if (verdict === "reauth_required") return { code: CLOSE_REAUTH_REQUIRED, reason: "Sign-in required" };
  return null;
}

export function readLease(value: unknown): SocketLease | null {
  if (!value || typeof value !== "object") return null;
  const lease = value as Partial<SocketLease>;
  if (lease.role !== "device" && lease.role !== "controller") return null;
  if (!Number.isSafeInteger(lease.userId) || typeof lease.deviceId !== "string") return null;
  if (!Number.isSafeInteger(lease.admittedAt) || !Number.isSafeInteger(lease.lastActiveAt)) return null;
  if (lease.role === "controller" && !Number.isSafeInteger(lease.reauthAt)) return null;
  return {
    role: lease.role,
    userId: lease.userId as number,
    deviceId: lease.deviceId,
    scopes: Array.isArray(lease.scopes) ? lease.scopes : [],
    connectionId: typeof lease.connectionId === "string" ? lease.connectionId : null,
    sessionId: typeof lease.sessionId === "string" ? lease.sessionId : null,
    admittedAt: lease.admittedAt as number,
    lastActiveAt: lease.lastActiveAt as number,
    reauthAt: Number.isSafeInteger(lease.reauthAt) ? lease.reauthAt as number : null,
  };
}
