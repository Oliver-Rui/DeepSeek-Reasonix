CREATE TABLE IF NOT EXISTS feedback_board_optin (
  account_hash TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  opted_in_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_board_delisted (
  account_hash TEXT PRIMARY KEY,
  name_key TEXT NOT NULL,
  delisted_at TEXT NOT NULL
);
