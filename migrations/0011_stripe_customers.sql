-- Which account a Stripe customer belongs to.
--
-- A `customer.subscription.*` event names a customer and never names us, so
-- without this the first subscription event for a new subscriber cannot be
-- attributed to anybody. The subscriptions table cannot answer it either:
-- the row it would answer from is the one the event is trying to create.
--
-- The link is learned at `checkout.session.completed`, which carries our own
-- account id in `client_reference_id`, and it is kept after a subscription
-- ends so that a person who resubscribes is recognized rather than stranded.
--
-- Stripe events can arrive in any order, so a subscription event that beats
-- its checkout session is expected rather than exceptional. The webhook
-- refuses that delivery and lets Stripe retry, by which time the session has
-- landed; see src/stripe.ts.

CREATE TABLE stripe_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL
);

CREATE INDEX stripe_customers_by_account ON stripe_customers (account_id);
