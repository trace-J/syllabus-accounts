-- The study assistant: what it may spend, and what it escalated.
--
-- Two new things need recording and neither fits the columns already here.
--
-- 1. An allowance of its own. Audio is metered in seconds and summaries in
--    tokens, and an assistant session is neither: it is a conversation whose
--    cost is dominated by how much course material it loaded and how much of
--    that was served from cache. It is metered in `assist_units`, which are
--    input-token equivalents at the Sonnet input rate (proxy.ts explains the
--    weights), plus a hard cap on how many sessions a month may hold. Both
--    are nullable because an account that has neither set is still on the
--    trial defaults in proxy.ts, exactly as it was for the other two meters.
--
-- 2. The escalation rate. The assistant loads course SUMMARIES by default,
--    about 15k tokens, and pulls one course's full transcripts, about 240k,
--    only when a question needs them. Every margin figure in HOME-STRETCH.md
--    assumes 15% of sessions escalate, and nobody has ever measured it: at
--    50% the Sonnet month is $8.82 rather than $3.96 and Pro at $22 stops
--    working. So the very first session this service ever serves is counted,
--    and whether it escalated is a column rather than something inferred
--    later from usage sizes.
--
-- One row per session, not per turn. The session id is the caller's, which
-- is why it is scoped by account in the primary key: two Macs choosing the
-- same id are two sessions, and a caller cannot reach another account's row
-- by guessing one.

ALTER TABLE allowances ADD COLUMN assist_units INTEGER;
ALTER TABLE allowances ADD COLUMN assist_sessions INTEGER;

CREATE TABLE assist_sessions (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  period      TEXT NOT NULL,
  -- 0 until a question needs one course's full transcripts, then 1 forever.
  -- A session that escalates is worth about eight of one that does not.
  escalated   INTEGER NOT NULL DEFAULT 0,
  -- Which course was opened, so a later question can ask what gets opened
  -- rather than only how often. Empty until something escalates.
  course      TEXT NOT NULL DEFAULT '',
  turns       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, session_id)
);

-- The two questions this table exists to answer: how many sessions did this
-- account start this month (the cap), and what share of them escalated (the
-- margin).
CREATE INDEX assist_sessions_by_period ON assist_sessions (account_id, period);
