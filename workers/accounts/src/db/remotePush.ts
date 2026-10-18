export interface PushCategories {
  approval: boolean;
  input: boolean;
  error: boolean;
}

interface PushRow {
  controller_id: string;
  user_id: number;
  host_device_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  notify_approval: number;
  notify_input: number;
  notify_error: number;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_status: number | null;
  failure_count: number;
  next_attempt_at: string | null;
}

// What a route may return: no endpoint, no keys. The endpoint is the device's
// capability to be notified, so it stays in this repository and the sender.
export interface PushSubscriptionView {
  controllerId: string;
  categories: PushCategories;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  failureCount: number;
}

export interface PushTarget {
  controllerId: string;
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

// A host has at most a few phones; the cap keeps one notification from fanning out without bound.
const MAX_TARGETS = 16;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

const COLUMNS = `controller_id, user_id, host_device_id, endpoint, p256dh, auth_secret, notify_approval, notify_input, notify_error,
  created_at, updated_at, last_success_at, last_failure_at, last_failure_status, failure_count, next_attempt_at`;

export function toPushView(row: PushRow): PushSubscriptionView {
  return {
    controllerId: row.controller_id,
    categories: { approval: row.notify_approval === 1, input: row.notify_input === 1, error: row.notify_error === 1 },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureStatus: row.last_failure_status,
    failureCount: row.failure_count,
  };
}

export class RemotePushRepo {
  constructor(private readonly db: D1Database) {}

  async get(userId: number, controllerId: string): Promise<PushSubscriptionView | null> {
    const row = await this.db.prepare(
      `SELECT ${COLUMNS} FROM remote_push_subscriptions WHERE controller_id = ?1 AND user_id = ?2`,
    ).bind(controllerId, userId).first<PushRow>();
    return row ? toPushView(row) : null;
  }

  // One subscription per controller, and one controller per endpoint: a browser
  // that enrolled again keeps its endpoint, so the older row goes with it. The
  // new row starts with nothing enabled unless the caller says so.
  async put(input: {
    userId: number;
    hostDeviceId: string;
    controllerId: string;
    endpoint: string;
    p256dh: string;
    authSecret: string;
    categories: PushCategories;
  }, now = new Date()): Promise<PushSubscriptionView> {
    const at = now.toISOString();
    const [, , row] = await this.db.batch<PushRow>([
      this.db.prepare("DELETE FROM remote_push_subscriptions WHERE endpoint = ?1 AND controller_id != ?2").bind(input.endpoint, input.controllerId),
      this.db.prepare(
        `INSERT INTO remote_push_subscriptions
           (controller_id, user_id, host_device_id, endpoint, p256dh, auth_secret, notify_approval, notify_input, notify_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT (controller_id) DO UPDATE SET
           endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret,
           notify_approval = excluded.notify_approval, notify_input = excluded.notify_input, notify_error = excluded.notify_error,
           updated_at = excluded.updated_at, failure_count = 0, last_failure_at = NULL, last_failure_status = NULL, next_attempt_at = NULL`,
      ).bind(
        input.controllerId, input.userId, input.hostDeviceId, input.endpoint, input.p256dh, input.authSecret,
        input.categories.approval ? 1 : 0, input.categories.input ? 1 : 0, input.categories.error ? 1 : 0, at,
      ),
      this.db.prepare(`SELECT ${COLUMNS} FROM remote_push_subscriptions WHERE controller_id = ?1`).bind(input.controllerId),
    ]);
    return toPushView((row?.results ?? [])[0] as PushRow);
  }

  async setCategories(userId: number, controllerId: string, categories: PushCategories, now = new Date()): Promise<PushSubscriptionView | null> {
    const row = await this.db.prepare(
      `UPDATE remote_push_subscriptions SET notify_approval = ?3, notify_input = ?4, notify_error = ?5, updated_at = ?6
       WHERE controller_id = ?1 AND user_id = ?2 RETURNING ${COLUMNS}`,
    ).bind(controllerId, userId, categories.approval ? 1 : 0, categories.input ? 1 : 0, categories.error ? 1 : 0, now.toISOString()).first<PushRow>();
    return row ? toPushView(row) : null;
  }

  async remove(userId: number, controllerId: string): Promise<boolean> {
    const result = await this.db.prepare(
      "DELETE FROM remote_push_subscriptions WHERE controller_id = ?1 AND user_id = ?2",
    ).bind(controllerId, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }

  // Who a notification of one category for one host may go to: an active
  // controller on an active host that turned the category on and is not waiting
  // out a failure. The join is what keeps a row that outlived a revocation from
  // receiving anything.
  async targets(userId: number, hostDeviceId: string, category: "approval" | "input" | "error", now: Date): Promise<PushTarget[]> {
    const column = category === "approval" ? "notify_approval" : category === "input" ? "notify_input" : "notify_error";
    const result = await this.db.prepare(
      `SELECT p.controller_id AS controller_id, p.endpoint AS endpoint, p.p256dh AS p256dh, p.auth_secret AS auth_secret
       FROM remote_push_subscriptions p
       JOIN remote_controllers c ON c.id = p.controller_id AND c.user_id = p.user_id AND c.host_device_id = p.host_device_id
       JOIN remote_devices d ON d.id = p.host_device_id AND d.user_id = p.user_id
       WHERE p.user_id = ?1 AND p.host_device_id = ?2 AND p.${column} = 1
         AND c.state = 'active' AND d.revoked_at IS NULL
         AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?3)
       ORDER BY p.controller_id LIMIT ?4`,
    ).bind(userId, hostDeviceId, now.toISOString(), MAX_TARGETS).all<{ controller_id: string; endpoint: string; p256dh: string; auth_secret: string }>();
    return (result.results ?? []).map((row) => ({ controllerId: row.controller_id, endpoint: row.endpoint, p256dh: row.p256dh, authSecret: row.auth_secret }));
  }

  async recordSuccess(controllerId: string, now: Date): Promise<void> {
    await this.db.prepare(
      `UPDATE remote_push_subscriptions SET last_success_at = ?2, failure_count = 0, last_failure_at = NULL,
         last_failure_status = NULL, next_attempt_at = NULL WHERE controller_id = ?1`,
    ).bind(controllerId, now.toISOString()).run();
  }

  // A delivery that failed but might work later. The wait doubles with each
  // consecutive failure up to six hours, so a dead endpoint is tried rarely
  // instead of on every notification.
  async recordFailure(controllerId: string, status: number, now: Date): Promise<void> {
    await this.db.prepare(
      `UPDATE remote_push_subscriptions SET failure_count = failure_count + 1, last_failure_at = ?2, last_failure_status = ?3,
         next_attempt_at = ?4 WHERE controller_id = ?1`,
    ).bind(controllerId, now.toISOString(), status, new Date(now.getTime() + (await this.backoffMs(controllerId))).toISOString()).run();
  }

  private async backoffMs(controllerId: string): Promise<number> {
    const row = await this.db.prepare("SELECT failure_count FROM remote_push_subscriptions WHERE controller_id = ?1").bind(controllerId).first<{ failure_count: number }>();
    const failures = (row?.failure_count ?? 0) + 1;
    return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  }

  // The push service said the subscription is gone for good.
  async removeGone(controllerId: string): Promise<void> {
    await this.db.prepare("DELETE FROM remote_push_subscriptions WHERE controller_id = ?1").bind(controllerId).run();
  }
}
