-- The Google Drive grant an account holds, one per account.
--
-- The refresh token is stored encrypted (AES-GCM under the DRIVE_KEY secret)
-- and is never sent to a panel; panels ask /drive/token for a one-hour
-- access token instead. google_email is which Google account granted it,
-- for the account page. A grant Google stops honoring is marked revoked
-- rather than deleted, so the page can say what happened.

CREATE TABLE drive_grants (
  account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  refresh_token_enc TEXT NOT NULL,
  scopes            TEXT NOT NULL,
  google_email      TEXT NOT NULL DEFAULT '',
  granted_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revoked_reason    TEXT NOT NULL DEFAULT ''
);
