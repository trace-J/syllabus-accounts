/**
 * Buying a plan, and changing one.
 *
 *   POST /billing/checkout   (session) start a Stripe Checkout for a tier
 *   POST /billing/portal     (session) open Stripe's Billing Portal
 *
 * Both are browser routes: a panel holds a device token that lives on a
 * laptop for months, and buying or canceling a subscription is not something
 * it does on its owner's behalf. Both hand off to a Stripe-hosted page, so
 * no card number, no billing address and no tax id is ever typed into
 * anything this service serves.
 *
 * Neither route grants anything. What somebody may spend is written by the
 * webhook (stripe.ts) when Stripe says the money moved, and enforced by the
 * proxy. A Checkout that completes and a webhook that never arrives leaves
 * the account exactly where it was, which is the right way around.
 */

import { Hono, type Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { page } from "./pages";
import { browserOnly, sameOrigin } from "./session";
import { stripeClient } from "./stripe";
import { entitlingSubscription, type TierName } from "./tiers";

export const billing = new Hono<AppEnv>();

/**
 * How long a Stripe trial runs if nothing ends it sooner.
 *
 * The trial is really 5 hours of audio, which is not a thing Stripe can
 * count, so it is expressed as a period that almost nobody reaches and ended
 * early when the hours are spent (endTrialIfSpent in stripe.ts). 90 days is
 * about a semester: long enough that somebody who signs up and then does not
 * record for a month is not charged for a product they never tried, and
 * short enough that an abandoned signup does not sit open forever.
 */
const TRIAL_PERIOD_DAYS = 90;

/** Which price a tier is bought at, from the vars in wrangler.jsonc. */
function priceFor(c: Context<AppEnv>, tier: TierName): string {
  if (tier === "starter") return c.env.STRIPE_PRICE_STARTER;
  if (tier === "standard") return c.env.STRIPE_PRICE_STANDARD;
  return c.env.STRIPE_PRICE_PRO;
}

function isTier(value: string): value is TierName {
  return value === "starter" || value === "standard" || value === "pro";
}

/** Everything a billing route needs before it can do anything, or a refusal. */
async function ready(c: Context<AppEnv>) {
  const refusal = browserOnly(c);
  if (refusal) return { refusal };
  const account = c.get("account");
  if (!account) return { refusal: c.redirect("/login?next=" + encodeURIComponent("/")) };
  // Says where a browser thinks it is, and nothing about who is asking, so it
  // is the second lock on a door browserOnly() is the first lock on.
  if (!sameOrigin(c)) return { refusal: c.text("Bad origin", 403) };
  if (!c.env.STRIPE_SECRET_KEY) {
    console.log("billing: a billing route was reached and STRIPE_SECRET_KEY is not set");
    return { refusal: c.html(problem("Billing is not switched on yet. Nothing was charged.")) };
  }
  return { account };
}

billing.post("/billing/checkout", async (c) => {
  const { refusal, account } = await ready(c);
  if (refusal) return refusal;

  const form = await c.req.formData();
  const wanted = String(form.get("tier") ?? "");
  if (!isTier(wanted)) return c.html(problem("That is not a plan we sell."));
  const price = priceFor(c, wanted);
  if (!price) {
    console.log(`billing: no price id is configured for ${wanted}`);
    return c.html(problem("That plan cannot be bought yet. Nothing was charged."));
  }
  /**
   * Redeeming a code and starting a trial are different sessions, because
   * they need opposite answers about the card.
   *
   * A trial has nothing to pay today, so Stripe only asks for a card when it
   * is told to always ask. The friends and family code is 100% off forever,
   * and a locked decision says that path must not ask for a card at all. One
   * session cannot be both, and Checkout cannot know at creation time whether
   * a code will be typed into it. So the person says which they are doing,
   * and somebody with a code gets no trial, which costs them nothing: their
   * subscription is free from the first day.
   */
  const redeeming = String(form.get("redeem") ?? "") === "1";

  // A customer we already have keeps one person to one Stripe customer, so
  // their invoices and their card stay in one place across a resubscription.
  const customer = await db.stripeCustomerOf(c.env.DB, account!.id);

  try {
    const session = await stripeClient(c.env).checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      // BOTH of these, on purpose. The webhook reads the subscription's own
      // metadata first, because a `customer.subscription.created` can arrive
      // before the session does and carries nothing else that names us.
      // client_reference_id is what the session itself is attributed by.
      client_reference_id: account!.id,
      subscription_data: {
        metadata: { account_id: account!.id },
        ...(redeeming ? {} : { trial_period_days: TRIAL_PERIOD_DAYS }),
      },
      ...(customer ? { customer, customer_update: { address: "auto", name: "auto" } } : { customer_email: account!.email }),
      // Texas taxes this as a data processing service, so an address has to be
      // collected before the tax can be worked out.
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      // The friends and family code is 100% off, and a subscription that costs
      // nothing must not stop to ask for a card it will never charge.
      allow_promotion_codes: true,
      payment_method_collection: redeeming ? "if_required" : "always",
      success_url: `${c.env.PUBLIC_URL}/?billing=done`,
      cancel_url: `${c.env.PUBLIC_URL}/?billing=canceled`,
    });
    if (!session.url) throw new Error("Stripe returned a session with no url");
    return c.redirect(session.url, 303);
  } catch (err) {
    console.log(`billing: checkout failed, ${(err as Error).message}`);
    return c.html(problem("Stripe could not start that. Nothing was charged."));
  }
});

billing.post("/billing/portal", async (c) => {
  const { refusal, account } = await ready(c);
  if (refusal) return refusal;

  const customer = await db.stripeCustomerOf(c.env.DB, account!.id);
  if (!customer) return c.html(problem("There is nothing to manage yet, because this account has never subscribed."));

  try {
    const session = await stripeClient(c.env).billingPortal.sessions.create({
      customer,
      return_url: `${c.env.PUBLIC_URL}/`,
    });
    return c.redirect(session.url, 303);
  } catch (err) {
    // The commonest cause by far is the portal never having been activated in
    // the Stripe dashboard, which is a settings page rather than a bug here.
    console.log(`billing: the portal would not open, ${(err as Error).message}`);
    return c.html(problem("Stripe could not open the billing page. Nothing has changed."));
  }
});

/**
 * Five more hours for this month, for somebody a cap has stopped.
 *
 * A one-time payment, not a change to the plan. The hours land on the current
 * period only and the button says so before the money moves; somebody who
 * needs them every month is better off on a bigger plan, and the price is set
 * so that is true.
 */
billing.post("/billing/topup", async (c) => {
  const { refusal, account } = await ready(c);
  if (refusal) return refusal;

  if (!c.env.STRIPE_PRICE_TOPUP) {
    console.log("billing: a top-up was asked for and STRIPE_PRICE_TOPUP is not set");
    return c.html(problem("Top-ups are not switched on yet. Nothing was charged."));
  }
  const customer = await db.stripeCustomerOf(c.env.DB, account!.id);

  try {
    const session = await stripeClient(c.env).checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: c.env.STRIPE_PRICE_TOPUP, quantity: 1 }],
      client_reference_id: account!.id,
      // A payment session has no subscription to stamp, so the session's own
      // metadata is the only thing that says whose hours these are and what
      // kind of purchase it was.
      metadata: { account_id: account!.id, kind: "topup" },
      ...(customer ? { customer, customer_update: { address: "auto" } } : { customer_email: account!.email }),
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      success_url: `${c.env.PUBLIC_URL}/?billing=topped-up`,
      cancel_url: `${c.env.PUBLIC_URL}/?billing=canceled`,
    });
    if (!session.url) throw new Error("Stripe returned a session with no url");
    return c.redirect(session.url, 303);
  } catch (err) {
    console.log(`billing: the top-up would not start, ${(err as Error).message}`);
    return c.html(problem("Stripe could not start that. Nothing was charged."));
  }
});

function problem(message: string): string {
  return page("Billing", `<p class="warn">${message}</p><p class="muted"><a href="/">Back to your account</a></p>`);
}

/**
 * What the account page says about money.
 *
 * Display only, and deliberately. This runs in the person's own browser and
 * is never asked whether anybody may record; the proxy reads the allowance
 * row and refuses on its own. If this section and the proxy ever disagree,
 * the proxy is right and this is a bug in the words.
 */
export type BillingView = {
  allowance: db.Allowance | null;
  subscription: db.Subscription | null;
  hasCustomer: boolean;
  audioUsed: number;
  /** Hours bought on top of the plan this month, in seconds. */
  toppedUp: number;
  /** Whether a top-up can be offered at all, which needs a Price in Stripe. */
  canTopUp: boolean;
};

export async function billingView(c: Context<AppEnv>, accountId: string): Promise<BillingView> {
  const [allowance, subs, customer, audioUsed, extra] = await Promise.all([
    db.allowance(c.env.DB, accountId),
    db.subscriptionsOf(c.env.DB, accountId),
    db.stripeCustomerOf(c.env.DB, accountId),
    db.usedThisPeriod(c.env.DB, accountId, "transcribe"),
    db.topupsThisPeriod(c.env.DB, accountId),
  ]);
  return {
    allowance,
    subscription: entitlingSubscription(subs),
    hasCustomer: Boolean(customer),
    audioUsed,
    toppedUp: extra.audio_seconds,
    canTopUp: Boolean(c.env.STRIPE_PRICE_TOPUP),
  };
}
