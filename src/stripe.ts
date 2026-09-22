/**
 * The Stripe webhook: the one thing in this service that writes an allowance.
 *
 *   POST /stripe/webhook   authenticated by Stripe's signature alone
 *
 * Stripe owns the subscription. This endpoint mirrors what Stripe says into
 * `subscriptions`, works out what that entitles with the rules in tiers.ts,
 * and writes the `allowances` row the proxy already enforces. The proxy is
 * unchanged and is still the only enforcement point; this is only what fills
 * in the row it reads.
 *
 * Three things make a webhook different from every other route here:
 *
 * 1. It carries no session cookie and no device token, so it is mounted
 *    before the auth middleware in index.ts and proves who it is with the
 *    signature.
 * 2. The signature covers the RAW body, so the body is read as text and
 *    parsed by Stripe's verifier rather than by Hono.
 * 3. Stripe retries until it gets a 2xx, and delivers the same event twice
 *    even after one. Handling an event twice is how an account silently gets
 *    two months of allowance, so every delivery claims its event id first.
 *
 * Nothing here calls Stripe back. Every field stored comes out of the event
 * body, which keeps a delivery to one D1 round trip and means a Stripe
 * outage cannot stop a webhook that has already arrived.
 */

import { Hono, type Context } from "hono";
import Stripe from "stripe";
import * as db from "./db";
import type { AppEnv, Bindings } from "./env";
import { allowanceFromSubscription, entitlingSubscription, tierForPrice } from "./tiers";

export const stripeHooks = new Hono<AppEnv>();

/**
 * A Stripe event is a few kilobytes. This is far above any real one and is
 * here so that an unauthenticated caller cannot make us hold, and HMAC, an
 * arbitrary amount of memory before the signature is even looked at.
 */
const MAX_EVENT_BYTES = 256 * 1024;

/**
 * Allowance sources this webhook will not overwrite.
 *
 * `owner` is granted by hand and is not a tier. Nothing should send a
 * subscription event for it, but the row is the one thing standing between
 * the account that runs this service and a 402, so it is protected rather
 * than trusted to never be touched.
 */
const PROTECTED_SOURCES = new Set(["owner"]);

/** The events that change what somebody is entitled to. Everything else is noted and ignored. */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/** Thrown when a delivery should be retried rather than accepted. */
class RetryLater extends Error {}

stripeHooks.post("/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    console.log("stripe: a webhook arrived and STRIPE_WEBHOOK_SECRET is not set; refusing it");
    return c.json({ error: "stripe_not_configured" }, 503);
  }
  const signature = c.req.header("stripe-signature") ?? "";
  if (!signature) return c.json({ error: "missing_signature" }, 400);

  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_EVENT_BYTES) return c.json({ error: "too_large", limit_bytes: MAX_EVENT_BYTES }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_EVENT_BYTES) return c.json({ error: "too_large", limit_bytes: MAX_EVENT_BYTES }, 413);

  let event: Stripe.Event;
  try {
    event = await verify(c.env, raw, signature);
  } catch (err) {
    // Never say which part failed. A bad signature and a stale timestamp are
    // the same answer to anybody who is not Stripe.
    console.log(`stripe: refused a delivery, ${(err as Error).message}`);
    return c.json({ error: "bad_signature" }, 400);
  }

  // The claim IS the insert, so two deliveries arriving together cannot both
  // find nothing and both grant a month.
  const first = await db.claimStripeEvent(c.env.DB, event.id, event.type);
  if (!first) {
    console.log(`stripe: ${event.type} ${event.id} was already handled`);
    return c.json({ ok: true, duplicate: true });
  }

  try {
    const accountId = await handle(c, event);
    if (accountId) await db.attributeStripeEvent(c.env.DB, event.id, accountId);
    return c.json({ ok: true });
  } catch (err) {
    // Hold no claim on an event we did not finish: Stripe's retry has to be
    // able to do the work, not be told it was already done.
    await db.releaseStripeEvent(c.env.DB, event.id);
    const why = (err as Error).message;
    if (err instanceof RetryLater) {
      console.log(`stripe: ${event.type} ${event.id} deferred, ${why}`);
      return c.json({ error: "retry_later" }, 500);
    }
    console.log(`stripe: ${event.type} ${event.id} failed, ${why}`);
    return c.json({ error: "handler_failed" }, 500);
  }
});

/**
 * Stripe's own verifier, told how to work inside workerd.
 *
 * The SDK's default HTTP client and crypto provider are Node's, and the
 * synchronous `constructEvent` throws here, so both are replaced. No request
 * is made: verification is an HMAC over the raw body, and the API key is
 * never spent.
 */
async function verify(env: Bindings, raw: string, signature: string): Promise<Stripe.Event> {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_unset", {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return stripe.webhooks.constructEventAsync(
    raw,
    signature,
    env.STRIPE_WEBHOOK_SECRET!,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

/** Deal with one verified event. Returns the account it was about, or "". */
async function handle(c: Context<AppEnv>, event: Stripe.Event): Promise<string> {
  if (!HANDLED.has(event.type)) {
    console.log(`stripe: ignoring ${event.type}`);
    return "";
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const accountId = idOf(session.client_reference_id) || idOf(session.metadata?.account_id);
    const customerId = idOf(session.customer);
    if (!accountId || !customerId) {
      throw new RetryLater(`a checkout session named ${accountId ? "no customer" : "no account"}`);
    }
    if (!(await db.accountById(c.env.DB, accountId))) {
      // Not retryable: a session naming an account that does not exist will
      // not start existing. Swallowed so Stripe stops, and logged so it is
      // findable.
      console.log(`stripe: checkout session named account ${accountId}, which does not exist`);
      return "";
    }
    await db.linkStripeCustomer(c.env.DB, customerId, accountId);
    // The subscription's own events carry the price, the status and the
    // period, so the allowance is written from those rather than from here.
    return accountId;
  }

  const sub = event.data.object as Stripe.Subscription;
  const accountId = await accountFor(c, sub);
  await db.putSubscription(c.env.DB, rowFor(c.env, sub, accountId));
  await writeAllowance(c, accountId);
  return accountId;
}

/**
 * Whose subscription this is.
 *
 * In order: what Checkout stamped on the subscription, the link learned at
 * checkout, and any subscription this customer already has here. A
 * subscription event that beats its own checkout session answers none of the
 * three, which is ordinary rather than exceptional, so it is deferred: Stripe
 * retries with backoff for about three days and the session lands long
 * before that. Accepting it instead would mean an event Stripe never sends
 * again and a subscriber who silently never got what they paid for.
 */
async function accountFor(c: Context<AppEnv>, sub: Stripe.Subscription): Promise<string> {
  const stamped = idOf(sub.metadata?.account_id);
  if (stamped && (await db.accountById(c.env.DB, stamped))) return stamped;

  const customerId = idOf(sub.customer);
  if (customerId) {
    const linked = await db.accountIdForLinkedCustomer(c.env.DB, customerId);
    if (linked) return linked;
    const known = await db.accountIdForCustomer(c.env.DB, customerId);
    if (known) return known;
  }
  throw new RetryLater(`no account is known for customer ${customerId || "(none)"}`);
}

/** What Stripe just said about a subscription, as a row of migrations/0010. */
function rowFor(
  env: Bindings,
  sub: Stripe.Subscription,
  accountId: string,
): Omit<db.Subscription, "created_at" | "updated_at"> {
  const item = sub.items?.data?.[0];
  const priceId = idOf(item?.price?.id);
  return {
    stripe_subscription_id: sub.id,
    account_id: accountId,
    stripe_customer_id: idOf(sub.customer),
    price_id: priceId,
    // Resolved now and stored, so a price retired in Stripe next year does
    // not make this year's rows unreadable.
    tier: tierForPrice(env, priceId) ?? "",
    status: sub.status,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
  };
}

/**
 * When the paid-up period ends, as an ISO 8601 string.
 *
 * Stripe moved `current_period_end` off the subscription and onto each of its
 * items, so the item is where a current API version puts it. The top-level
 * field is read as well because the account's API version is a dashboard
 * setting that nobody here controls, and an older one still sends it. A
 * subscription with neither is stored with '' and entitles on its status
 * alone, which is what tiers.ts does with an empty period end.
 */
function periodEnd(sub: Stripe.Subscription): string {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  const seconds = item?.current_period_end ?? legacy;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

/**
 * Recompute what an account may spend, from every subscription it holds.
 *
 * Computed from the rows rather than from the event, because an account can
 * hold more than one subscription and the event only ever describes one of
 * them: somebody who upgrades mid-month has a canceled Starter beside a live
 * Pro, and the Starter's own `deleted` event must not be what decides.
 */
async function writeAllowance(c: Context<AppEnv>, accountId: string): Promise<void> {
  const existing = await db.allowance(c.env.DB, accountId);
  if (existing && PROTECTED_SOURCES.has(existing.source)) {
    console.log(`stripe: leaving the ${existing.source} allowance on account ${accountId} alone`);
    return;
  }
  const subs = await db.subscriptionsOf(c.env.DB, accountId);
  const best = entitlingSubscription(subs);
  // Nothing to derive from. An account with no rows at all has never
  // subscribed, and a missing allowance is what the proxy reads as the trial.
  if (!best) return;
  const grant = allowanceFromSubscription(best);
  await db.putAllowance(c.env.DB, accountId, grant);
  console.log(`stripe: account ${accountId} is now on ${grant.source}`);
}

/** A Stripe field that is a string, an expanded object, or absent. */
function idOf(value: string | { id?: string } | null | undefined): string {
  if (typeof value === "string") return value;
  return value?.id ?? "";
}
