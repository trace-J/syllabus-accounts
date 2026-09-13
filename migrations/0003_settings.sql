-- Per-account settings documents, one row per (account, profile, name).
--
-- The first document is "schedule": the text of schedule.toml (calls.toml
-- for Sous), so a person's class schedule follows them to another Mac. The
-- content is stored as the panel wrote it, comments and all; the service
-- never parses it. updated_by names the device that last wrote it.

CREATE TABLE settings (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile     TEXT NOT NULL,
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, profile, name)
);
