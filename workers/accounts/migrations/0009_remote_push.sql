-- One Web Push subscription per enrolled controller (a phone's browser). The
-- endpoint and keys are the device's capability to be notified and are never
-- returned by a route. Rows are written only with a proof of possession of the
-- controller key, and are deleted with the controller or its host: the sender
-- also joins to active rows, so a row that outlived either never receives.
-- Every category is opt-in, so a subscription without a choice sends nothing.

CREATE TABLE IF NOT EXISTS remote_push_subscriptions (
  controller_id       TEXT    PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  host_device_id      TEXT    NOT NULL,
  endpoint            TEXT    NOT NULL UNIQUE,
  p256dh              TEXT    NOT NULL,
  auth_secret         TEXT    NOT NULL,
  notify_approval     INTEGER NOT NULL DEFAULT 0,
  notify_input        INTEGER NOT NULL DEFAULT 0,
  notify_error        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  last_success_at     TEXT,
  last_failure_at     TEXT,
  last_failure_status INTEGER,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  CHECK (notify_approval IN (0, 1) AND notify_input IN (0, 1) AND notify_error IN (0, 1))
);
CREATE INDEX IF NOT EXISTS remote_push_host ON remote_push_subscriptions (user_id, host_device_id);
