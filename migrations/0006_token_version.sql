-- One number that invalidates every device token an account ever handed out.
--
-- Revoking devices one at a time is fine for "I sold that laptop". It is not
-- enough after a token is stolen: a stolen token could enroll more devices,
-- so the list you are working down may have grown while you worked down it.
-- Bumping the account's token_version orphans every token issued before the
-- bump in a single statement, whatever device it belongs to.

ALTER TABLE accounts ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_tokens ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
