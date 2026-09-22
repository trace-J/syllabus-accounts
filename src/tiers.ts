/**
 * What each tier is worth, and how a Stripe subscription becomes one.
 *
 * This file is the only place the commercial plan is written down in code.
 * Nothing here calls Stripe and nothing here writes to the database: it turns
 * a subscription row into the allowance row the proxy already reads, so the
 * rules can be tested without a webhook, a key, or a network.
 *
 * The proxy is the only enforcement point. A panel may hide and dim; it runs
 * on the user's Mac, so it is never asked whether somebody may record.
 */

import type { Bindings } from "./env";
import type { Subscription } from "./db";

export type TierName = "starter" | "standard" | "pro";

/** An allowance row, before it has an account attached. */
export type AllowanceGrant = {
  audio_seconds: number;
  summary_tokens: number;
  assistant_sessions: number;
  /** Where the grant came from, for a support question a month later. */
  source: string;
};

/**
 * Summary tokens per tier are the TRIAL's ratio: 30k per audio hour.
 *
 * The handoff flagged this as a call to make out loud rather than to pick
 * quietly, because it decides which of the two meters a user actually hits.
 * The choice is between the trial's ratio and the measured one: a real
 * lecture hour models at about 9.5k summary tokens, so a tight cap would be
 * nearer 12k an hour with slack.
 *
 * The hour cap is the one the tiers are priced on and the one a student can
 * reason about ("two courses"), so the token cap must be headroom and must
 * never be what runs out first. The measured ratio is only 25% above the
 * modeled spend, which a retry storm or a long lecture would eat; at 30k an
 * hour a tier would have to spend three times its modeled tokens before the
 * token meter bound anything. That costs nothing when the ratio is never
 * reached, and it stops a support ticket that begins "it says I have 20 hours
 * left but it will not summarize".
 *
 * The audio hours are HOME-STRETCH's, which the published prices were set
 * against. Assistant sessions are Pro's 15; nothing meters them yet (see
 * migrations/0010) and no other tier includes any.
 */
export const TIERS: Record<TierName, AllowanceGrant & { price_usd: number; audio_hours: number }> = {
  starter: {
    price_usd: 9,
    audio_hours: 15,
    audio_seconds: 15 * 3600,
    summary_tokens: 450_000,
    assistant_sessions: 0,
    source: "starter",
  },
  standard: {
    price_usd: 15,
    audio_hours: 30,
    audio_seconds: 30 * 3600,
    summary_tokens: 900_000,
    assistant_sessions: 0,
    source: "standard",
  },
  pro: {
    price_usd: 25,
    audio_hours: 45,
    audio_seconds: 45 * 3600,
    summary_tokens: 1_350_000,
    assistant_sessions: 15,
    source: "pro",
  },
};

/**
 * The 5-hour trial. Audio is metered in seconds, summaries in tokens.
 *
 * It is two things at once, which is why it lives here rather than beside the
 * proxy that reads it. It is what an account with no allowance row at all
 * gets, which is every account that has never been through checkout. And it
 * is what a subscription inside its Stripe trial is worth: somebody who has
 * picked a plan and handed over a card has 5 hours to find out whether this
 * works before the card is charged, not the plan's full month.
 *
 * 5 hours of lecture needs about 48k summary tokens, so the token figure is
 * headroom for retries rather than a second product limit. That is the same
 * reasoning, and the same 30k an hour, as the tiers above.
 */
export const TRIAL_ALLOWANCE = { audio_seconds: 5 * 3600, summary_tokens: 150_000 };

/** The trial as a grant, ready to be written to a row. */
export const TRIAL_GRANT: AllowanceGrant = {
  audio_seconds: TRIAL_ALLOWANCE.audio_seconds,
  summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
  assistant_sessions: 0,
  source: "trial",
};

/**
 * What one top-up buys: 5 more hours, and the tokens to summarize them.
 *
 * Priced above a plan's hour on purpose. Starter works out at $0.60 an hour
 * and Pro at $0.55; a top-up is $1.00, which covers the card fee on a small
 * one-off charge and leaves upgrading as the cheaper answer for anybody who
 * needs more hours every month. Tokens follow the same 30k an hour as
 * everything else, so a top-up is usable rather than nominally granted.
 */
export const TOPUP = {
  audio_hours: 5,
  price_usd: 5,
  audio_seconds: 5 * 3600,
  summary_tokens: 5 * 30_000,
};

/**
 * What an account gets when its subscription has stopped paying for anything.
 *
 * Not the trial. An account with no row at all falls back to the trial in
 * src/proxy.ts, which is right for somebody who has never subscribed; giving
 * it back to somebody whose subscription ended would hand them five free
 * hours every month forever.
 */
export const LAPSED_ALLOWANCE: AllowanceGrant = {
  audio_seconds: 0,
  summary_tokens: 0,
  assistant_sessions: 0,
  source: "lapsed",
};

/**
 * The statuses that entitle.
 *
 * `past_due` is deliberately in the list. Stripe keeps a subscription in it
 * while it retries a card, for up to about two weeks, and cutting a student
 * off mid-semester over a card that expired is the wrong way to fail. The
 * subscription reaches `unpaid` or `canceled` when Stripe gives up, and both
 * of those stop entitling.
 */
const ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * How long after `current_period_end` a subscription still entitles.
 *
 * Stripe moves the period forward on every renewal, so a live subscription's
 * period end is always in the future. One in the past means we never heard
 * about a renewal, and a webhook we never heard is also how we would miss a
 * cancellation. The grace is what keeps a slow or retried delivery from
 * cutting somebody off; past it, we stop trusting a row nothing has confirmed
 * in three days.
 */
const PERIOD_END_GRACE_MS = 3 * 24 * 3600 * 1000;

/**
 * Which price id is which tier, from the Worker's vars.
 *
 * The ids themselves are not in this file on purpose. A Stripe price id is
 * different in test mode and in live mode, so hardcoding one means the test
 * account and the real account cannot both work, and means a price the
 * dashboard replaces is a code change. The tier table above is in code; the
 * three ids that point at it are configuration.
 */
export function tierForPrice(env: Pick<Bindings, "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_STANDARD" | "STRIPE_PRICE_PRO">, priceId: string): TierName | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === env.STRIPE_PRICE_STANDARD) return "standard";
  if (priceId === env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

/**
 * The allowance a tier is worth, as a row ready to be written.
 *
 * An unknown tier name is treated as Starter rather than as nothing. The only
 * way to get one is a price created in Stripe that the vars above were never
 * told about, which means somebody is paying us and the mistake is ours.
 * Starter is the cheapest thing that is wrong; a zero would be a paying
 * customer locked out of a product they just bought.
 */
export function allowanceForTier(tier: string): AllowanceGrant {
  const known = TIERS[tier as TierName];
  if (known) return { ...grantOf(known) };
  console.log(`tiers: no allowance is defined for tier "${tier}"; granting starter`);
  return { ...grantOf(TIERS.starter), source: tier || "unknown" };
}

function grantOf(tier: AllowanceGrant): AllowanceGrant {
  return {
    audio_seconds: tier.audio_seconds,
    summary_tokens: tier.summary_tokens,
    assistant_sessions: tier.assistant_sessions,
    source: tier.source,
  };
}

/** Whether this subscription pays for anything right now. */
export function entitles(sub: Pick<Subscription, "status" | "current_period_end">, at: Date = new Date()): boolean {
  if (!ENTITLING_STATUSES.has(sub.status)) return false;
  if (!sub.current_period_end) return true;
  const ends = Date.parse(sub.current_period_end);
  if (Number.isNaN(ends)) return true;
  return ends + PERIOD_END_GRACE_MS > at.getTime();
}

/**
 * The allowance row a subscription is worth.
 *
 * This is the whole of the entitlement rule. `cancel_at_period_end` is not
 * consulted: a subscription that is set to cancel is still paid up until it
 * does, and Stripe moves it to `canceled` itself when the period runs out.
 */
export function allowanceFromSubscription(sub: Subscription, at: Date = new Date()): AllowanceGrant {
  if (!entitles(sub, at)) return { ...LAPSED_ALLOWANCE };
  // A Stripe trial is the 5 hours, not the plan. The card is collected at
  // checkout and charged when the trial ends, which is either when those
  // hours are spent (src/billing.ts ends it early) or when the trial period
  // runs out on its own.
  if (sub.status === "trialing") return { ...TRIAL_GRANT };
  return allowanceForTier(sub.tier);
}

/**
 * The one subscription an account's allowance should be computed from.
 *
 * An account can hold several rows (see migrations/0010). The one that counts
 * is the best one that entitles: somebody who upgraded mid-month has a
 * canceled Starter beside a live Pro, and the old row must not be what
 * answers. When none of them entitles, the most recently created row is
 * returned so that the allowance says "lapsed" rather than "never
 * subscribed", and null means the account has never had a subscription at
 * all, which is the trial case the proxy already handles.
 */
export function entitlingSubscription(subs: Subscription[], at: Date = new Date()): Subscription | null {
  const rank: Record<string, number> = { starter: 1, standard: 2, pro: 3 };
  const live = subs.filter((s) => entitles(s, at));
  const pool = live.length > 0 ? live : subs;
  let best: Subscription | null = null;
  for (const sub of pool) {
    if (!best) {
      best = sub;
      continue;
    }
    if (live.length > 0) {
      if ((rank[sub.tier] ?? 0) > (rank[best.tier] ?? 0)) best = sub;
      continue;
    }
    if (sub.created_at > best.created_at) best = sub;
  }
  return best;
}

/**
 * The tiers as a person reads them, in the order the pricing page lists them.
 *
 * Here rather than beside the Checkout routes so that the account page can
 * render a price without importing the Stripe SDK to do it. The wording
 * agrees with maincoursemedia.com/syllabus without copying it: two places
 * that describe the same three plans should not drift, and neither should
 * read as a paste of the other.
 */
export const SELLABLE: { tier: TierName; label: string; note: string }[] = [
  {
    tier: "starter",
    label: "Starter",
    note: `$${TIERS.starter.price_usd} a month, ${TIERS.starter.audio_hours} hours. About two courses.`,
  },
  {
    tier: "standard",
    label: "Standard",
    note: `$${TIERS.standard.price_usd} a month, ${TIERS.standard.audio_hours} hours. Most popular.`,
  },
  {
    tier: "pro",
    label: "Pro",
    note: `$${TIERS.pro.price_usd} a month, ${TIERS.pro.audio_hours} hours, plus ${TIERS.pro.assistant_sessions} study sessions.`,
  },
];
