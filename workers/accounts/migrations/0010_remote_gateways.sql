-- Gateways a person runs themselves. The hosted gateway keeps the shared
-- secret and owns every device with a NULL gateway_id; a registered gateway
-- gets its own token, which is accepted only for devices bound to it. The
-- token is never stored, only its hash.

CREATE TABLE IF NOT EXISTS remote_gateways (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  label        TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  UNIQUE (user_id, origin)
);
CREATE INDEX IF NOT EXISTS remote_gateways_user ON remote_gateways (user_id, revoked_at);

ALTER TABLE remote_devices ADD COLUMN gateway_id TEXT;
CREATE INDEX IF NOT EXISTS remote_devices_gateway ON remote_devices (gateway_id);
