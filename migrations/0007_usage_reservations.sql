-- Usage rows are written before the upstream call, not after it.
--
-- The allowance used to be checked against a SUM and then written once the
-- provider answered, which is two statements with a paid call between them.
-- Two requests arriving together both read the total from before either of
-- them, both found room, and both spent it: the account's cap was a
-- suggestion under concurrency.
--
-- A row now goes in first, in the same statement that checks the total, and
-- carries what it is: 'reserved' while the call is in flight, 'final' once
-- the provider has said what it actually cost. A reserved row counts against
-- the allowance exactly as a final one does, which is what makes the second
-- concurrent request see the first.
--
-- Rows written before this migration were all settled calls, so 'final' is
-- the right default for them.

ALTER TABLE usage ADD COLUMN state TEXT NOT NULL DEFAULT 'final';

-- For releasing reservations a dead Worker left behind.
CREATE INDEX usage_reserved ON usage (state, created_at);
