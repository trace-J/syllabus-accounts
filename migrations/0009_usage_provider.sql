-- Which provider served a paid call, so the bill can be read back apart.
--
-- /proxy/transcribe tries Groq and falls back to OpenAI on any failure, at
-- roughly 1.6x the price. That made the cost of an audio hour a number nobody
-- could look up: a fall-through was logged live and then gone, so the only
-- record of a month spent on the expensive leg was the card statement.
--
-- usage rows are what the allowance is computed from, and they already carry
-- one row per call, so the provider belongs on them rather than in a counter
-- beside them. The split, the seconds behind it, and the account it happened
-- to are then one GROUP BY apart, and no second thing can disagree with the
-- bill.
--
-- Written at settle time, not at reserve time: a reservation is made before
-- the call and cannot know who will answer it. Rows written before this
-- migration, and any reservation still in flight, carry '' for "not
-- recorded", which is honest and is never mistaken for a provider name.

ALTER TABLE usage ADD COLUMN provider TEXT NOT NULL DEFAULT '';

-- The split query: kind and period select the rows, provider groups them.
CREATE INDEX usage_by_provider ON usage (kind, period, provider);
