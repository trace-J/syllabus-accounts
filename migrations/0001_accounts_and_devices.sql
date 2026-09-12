-- Who has a Syllabus account, and which Macs run a panel under it.
--
-- An account is a Google identity. A device is one running panel (one Mac,
-- one profile) claimed into an account through the device-code flow. The
-- device token is the panel's long-lived credential; only its hash is kept.
-- A device code is one claim in progress and lives fifteen minutes.

CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  google_sub     TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  picture        TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  last_signin_at TEXT NOT NULL
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  profile      TEXT NOT NULL DEFAULT 'syllabus',
  public_url   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX devices_by_account ON devices(account_id);

CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX device_tokens_by_device ON device_tokens(device_id);

CREATE TABLE device_codes (
  device_code_hash    TEXT PRIMARY KEY,
  user_code           TEXT NOT NULL UNIQUE,
  profile             TEXT NOT NULL DEFAULT 'syllabus',
  device_name         TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  approved_account_id TEXT,
  approved_device_id  TEXT,
  collected_at        TEXT
);
