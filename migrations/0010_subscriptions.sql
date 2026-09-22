-- What an account pays for, as Stripe last told us.
--
-- This table is a mirror, not a source of truth. Stripe owns the
-- subscription; the webhook (slice 4b) writes what it says here so that the
-- proxy never has to make a network call to find out whether somebody may
-- record. Every column is a field of a Stripe subscription object, kept in
-- Stripe's own vocabulary so a support question can be answered by putting
-- this row next to the dashboard.
--
-- The primary key is the STRIPE subscription id rather than the account,
-- because an account can hold more than one row: a canceled subscription and
-- the new one that replaced it both exist for a while, and webhooks for the
-- two can arrive in either order. An account-keyed table would let a late
-- "deleted" for the old subscription overwrite the live one. src/tiers.ts
-- picks the row that entitles instead, so an out-of-order delivery costs
-- nothing.
--
-- tier is derived from price_id when the row is written, and stored, so that
-- a price retired in Stripe next year does not make this year's rows
-- unreadable.
--
-- current_period_end is ISO 8601 UTC, like every other timestamp here, rather
-- than the Unix seconds Stripe sends. cancel_at_period_end is 0 or 1.

CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  price_id               TEXT NOT NULL,
  tier                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  current_period_end     TEXT NOT NULL DEFAULT '',
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- The read path: every subscription an account holds, newest first.
CREATE INDEX subscriptions_by_account ON subscriptions (account_id, created_at);

-- The webhook path: an event carries a customer id and has to find the account.
CREATE INDEX subscriptions_by_customer ON subscriptions (stripe_customer_id);

-- Every Stripe event we have already handled.
--
-- Stripe retries a webhook until it gets a 2xx, and it will deliver the same
-- event twice even after one. Handling an event twice is not harmless here:
-- it is how an account silently gets two months of allowance. The event id is
-- the primary key, so the second delivery loses an INSERT race rather than
-- being checked and then acted on, which is the same reasoning as the
-- reservation in migrations/0007.
--
-- type and account_id are for reading, not for logic: they are what makes
-- this table answer "what has Stripe told us about this person" a month
-- later. account_id is '' for an event we could not attribute.

CREATE TABLE stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  account_id  TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL
);

CREATE INDEX stripe_events_by_account ON stripe_events (account_id, received_at);

-- Pro is sold as 45 hours plus 15 study assistant sessions, so an allowance
-- row that cannot carry the sessions is not the entitlement that was sold.
--
-- Nothing enforces this column yet, and nothing can: the study assistant runs
-- on one Mac's own Anthropic key and never reaches this service, so there is
-- no /proxy/assistant to meter it at. It is added now rather than with that
-- endpoint so that no allowance row ever exists without it. The alternative
-- was a migration later plus a pass over live subscribers' rows to fill it
-- in, which is more work at a worse time.
ALTER TABLE allowances ADD COLUMN assistant_sessions INTEGER NOT NULL DEFAULT 0;
