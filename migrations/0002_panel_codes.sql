-- One-time codes that carry a browser sign-in from this service to a panel.
--
-- A panel reached over the web sends the browser here; once the person is
-- signed in and owns that panel's device, a code is minted and the browser
-- is sent back to the panel with it. The panel trades the code for the
-- account using its own device token, so a code is worthless to anyone but
-- that panel. Codes live five minutes and are redeemed once.

CREATE TABLE panel_codes (
  code_hash    TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
