-- Hours somebody bought on top of their plan, when a cap stopped them.
--
-- A cap here is a hard stop and never a surprise bill, which is a locked
-- decision: a student who runs out is refused, and is offered one more
-- purchase rather than being billed for going over. This table is what that
-- purchase becomes.
--
-- A top-up is added to the allowance for the PERIOD it was bought in, and
-- does not carry into the next one. That is the honest shape for something
-- bought because a cap was reached today, and the page says so before the
-- money moves rather than after. It also keeps the arithmetic in one place:
-- src/proxy.ts sums this period's rows onto the monthly allowance, so the
-- reservation, the ceiling and the refusal all keep working unchanged.
--
-- Written only by the Stripe webhook, like allowances. stripe_session_id is
-- unique, so a redelivered checkout.session.completed cannot grant the hours
-- twice even if the event claim in stripe_events were somehow lost.

CREATE TABLE topups (
  stripe_session_id TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,
  audio_seconds     INTEGER NOT NULL,
  summary_tokens    INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

-- The read the proxy does on every paid call: one account, one month.
CREATE INDEX topups_by_period ON topups (account_id, period);
