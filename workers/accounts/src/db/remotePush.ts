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
}
