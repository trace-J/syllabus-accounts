import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import { TRIAL_ALLOWANCE } from "../src/proxy";
import {
  allowanceForTier,
  allowanceFromSubscription,
  entitles,
  entitlingSubscription,
  LAPSED_ALLOWANCE,
  TIERS,
  tierForPrice,
} from "../src/tiers";
import { claimDevice, get, signedInAs } from "./helpers";

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** A subscription row as the webhook in slice 4b will write one. */
function subscription(over: Partial<db.Subscription> = {}): db.Subscription {
  return {
    stripe_subscription_id: "sub_" + Math.random().toString(36).slice(2, 10),
    account_id: "acct-local",
    stripe_customer_id: "cus_test",
    price_id: "price_test_pro",
    tier: "pro",
    status: "active",
    current_period_end: new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString(),
    cancel_at_period_end: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("the tier table", () => {
  it("carries the hours and prices the plan was written against", () => {
    expect(TIERS.starter).toMatchObject({ price_usd: 9, audio_hours: 15, audio_seconds: 15 * 3600 });
    expect(TIERS.standard).toMatchObject({ price_usd: 15, audio_hours: 30, audio_seconds: 30 * 3600 });
    expect(TIERS.pro).toMatchObject({ price_usd: 25, audio_hours: 45, audio_seconds: 45 * 3600 });
  });

  it("gives Pro the 15 study sessions it is sold with, and no other tier any", () => {
    expect(TIERS.pro.assistant_sessions).toBe(15);
    expect(TIERS.starter.assistant_sessions).toBe(0);
    expect(TIERS.standard.assistant_sessions).toBe(0);
  });

  it("keeps the token cap as headroom, never as the binding limit", () => {
    // The decision this slice had to make out loud: 30k summary tokens per
    // audio hour, the trial's ratio. A real lecture hour models at ~9.5k, so
    // a tier has to spend three times its modeled tokens before the token
    // meter can run out before the hour meter does. The hours are what the
    // prices were set against and what a student can reason about.
    const MODELED_TOKENS_PER_HOUR = 9_500;
    for (const tier of Object.values(TIERS)) {
      expect(tier.summary_tokens / tier.audio_hours).toBe(30_000);
      expect(tier.summary_tokens).toBeGreaterThan(tier.audio_hours * MODELED_TOKENS_PER_HOUR * 3);
    }
    // The trial the proxy already hands out uses the same ratio.
    expect(TRIAL_ALLOWANCE.summary_tokens / (TRIAL_ALLOWANCE.audio_seconds / 3600)).toBe(30_000);
  });
});

describe("a price id becomes a tier", () => {
  it("maps the three configured prices", () => {
    expect(tierForPrice(env, "price_test_starter")).toBe("starter");
    expect(tierForPrice(env, "price_test_standard")).toBe("standard");
    expect(tierForPrice(env, "price_test_pro")).toBe("pro");
  });

  it("knows nothing about a price it was not told", () => {
    expect(tierForPrice(env, "price_live_something_else")).toBeNull();
  });

  it("does not let an unconfigured tier match an empty price id", () => {
    const unset = { STRIPE_PRICE_STARTER: "", STRIPE_PRICE_STANDARD: "", STRIPE_PRICE_PRO: "" };
    expect(tierForPrice(unset, "")).toBeNull();
    expect(tierForPrice(env, "")).toBeNull();
  });
});

describe("a subscription becomes an allowance", () => {
  it("pays the tier's allowance while it is active", () => {
    expect(allowanceFromSubscription(subscription({ tier: "pro" }))).toEqual({
      audio_seconds: 45 * 3600,
      summary_tokens: 1_350_000,
      assistant_sessions: 15,
      source: "pro",
    });
    expect(allowanceFromSubscription(subscription({ tier: "starter" }))).toEqual({
      audio_seconds: 15 * 3600,
      summary_tokens: 450_000,
      assistant_sessions: 0,
      source: "starter",
    });
  });

  it("pays during a Stripe trial and while a card is being retried", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(entitles(subscription({ status }))).toBe(true);
    }
  });

  it("stops paying once Stripe has given up on it", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(allowanceFromSubscription(subscription({ status }))).toEqual(LAPSED_ALLOWANCE);
    }
  });

  it("does not hand a lapsed subscriber the trial back", () => {
    // A missing row means the trial (the proxy's fallback). A lapsed row means
    // zero. If lapsing wrote the trial instead, a canceled account would draw
    // five free hours every month for as long as it existed.
    const lapsed = allowanceFromSubscription(subscription({ status: "canceled" }));
    expect(lapsed.audio_seconds).toBe(0);
    expect(lapsed.summary_tokens).toBe(0);
    expect(lapsed.source).toBe("lapsed");
    expect(lapsed.audio_seconds).not.toBe(TRIAL_ALLOWANCE.audio_seconds);
  });

  it("still pays a subscription that is set to cancel at the period end", () => {
    const sub = subscription({ cancel_at_period_end: 1 });
    expect(allowanceFromSubscription(sub).source).toBe("pro");
  });

  it("stops trusting a period end that nothing has renewed", () => {
    const ended = new Date("2026-09-01T00:00:00.000Z");
    const sub = subscription({ current_period_end: ended.toISOString() });
    // Inside the grace, a slow or retried webhook must not cut anybody off.
    expect(entitles(sub, new Date("2026-09-03T00:00:00.000Z"))).toBe(true);
    // Past it, a row nothing has confirmed for three days stops paying.
    expect(entitles(sub, new Date("2026-09-05T00:00:00.000Z"))).toBe(false);
    expect(allowanceFromSubscription(sub, new Date("2026-09-05T00:00:00.000Z"))).toEqual(LAPSED_ALLOWANCE);
  });

  it("entitles when Stripe sent no period end at all", () => {
    expect(entitles(subscription({ current_period_end: "" }))).toBe(true);
  });

  it("gives a price we do not recognize the cheapest tier, not nothing", () => {
    // The only way here is a Product created in Stripe that the vars were
    // never told about, which means somebody is paying and the mistake is
    // ours. The source records what it actually was.
    const unknown = allowanceForTier("platinum");
    expect(unknown.audio_seconds).toBe(TIERS.starter.audio_seconds);
    expect(unknown.source).toBe("platinum");
  });
});

describe("which of an account's subscriptions counts", () => {
  it("takes the live one over the one it replaced", () => {
    const old = subscription({ tier: "starter", status: "canceled", created_at: "2026-08-01T00:00:00.000Z" });
    const live = subscription({ tier: "pro", status: "active", created_at: "2026-09-01T00:00:00.000Z" });
    expect(entitlingSubscription([old, live])?.tier).toBe("pro");
    expect(entitlingSubscription([live, old])?.tier).toBe("pro");
  });

  it("takes the better tier when two are live at once", () => {
    const starter = subscription({ tier: "starter", created_at: "2026-09-01T00:00:00.000Z" });
    const pro = subscription({ tier: "pro", created_at: "2026-08-01T00:00:00.000Z" });
    expect(entitlingSubscription([starter, pro])?.tier).toBe("pro");
  });

  it("takes the most recent when none of them pays, so the source says lapsed", () => {
    const first = subscription({ tier: "starter", status: "canceled", created_at: "2026-07-01T00:00:00.000Z" });
    const second = subscription({ tier: "pro", status: "canceled", created_at: "2026-08-01T00:00:00.000Z" });
    expect(entitlingSubscription([first, second])?.tier).toBe("pro");
    expect(allowanceFromSubscription(entitlingSubscription([first, second])!)).toEqual(LAPSED_ALLOWANCE);
  });

  it("says nothing at all about an account that never subscribed", () => {
    expect(entitlingSubscription([])).toBeNull();
  });
});

describe("the rows themselves", () => {
  it("stores a subscription and reads it back", async () => {
    const { account } = await signedInAs("subs@example.com");
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_round_trip",
      account_id: account.id,
      stripe_customer_id: "cus_round_trip",
      price_id: "price_test_standard",
      tier: "standard",
      status: "active",
      current_period_end: "2026-10-15T00:00:00.000Z",
      cancel_at_period_end: 0,
    });
    const rows = await db.subscriptionsOf(env.DB, account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "standard", status: "active", cancel_at_period_end: 0 });
    expect(await db.accountIdForCustomer(env.DB, "cus_round_trip")).toBe(account.id);
  });

  it("updates a subscription in place, keeping when we first heard of it", async () => {
    const { account } = await signedInAs("upgrade@example.com");
    const base = {
      stripe_subscription_id: "sub_in_place",
      account_id: account.id,
      stripe_customer_id: "cus_in_place",
      price_id: "price_test_starter",
      tier: "starter",
      status: "active",
      current_period_end: "2026-10-15T00:00:00.000Z",
      cancel_at_period_end: 0,
    };
    await db.putSubscription(env.DB, base);
    const first = await db.subscriptionById(env.DB, "sub_in_place");
    await db.putSubscription(env.DB, { ...base, price_id: "price_test_pro", tier: "pro", cancel_at_period_end: 1 });
    const after = await db.subscriptionById(env.DB, "sub_in_place");
    expect(await db.subscriptionsOf(env.DB, account.id)).toHaveLength(1);
    expect(after).toMatchObject({ tier: "pro", cancel_at_period_end: 1 });
    expect(after!.created_at).toBe(first!.created_at);
  });

  it("lets a Stripe event be handled once and only once", async () => {
    expect(await db.claimStripeEvent(env.DB, "evt_once", "customer.subscription.updated")).toBe(true);
    expect(await db.claimStripeEvent(env.DB, "evt_once", "customer.subscription.updated")).toBe(false);
    expect(await db.claimStripeEvent(env.DB, "evt_other", "customer.subscription.updated")).toBe(true);
  });

  it("can attribute an event once it knows whose it is", async () => {
    const { account } = await signedInAs("attributed@example.com");
    await db.claimStripeEvent(env.DB, "evt_unattributed", "invoice.paid");
    await db.attributeStripeEvent(env.DB, "evt_unattributed", account.id);
    const row = await env.DB.prepare("SELECT account_id FROM stripe_events WHERE id = ?")
      .bind("evt_unattributed")
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe(account.id);
  });

  it("carries the assistant sessions on an allowance row", async () => {
    const { account } = await signedInAs("sessions@example.com");
    await db.putAllowance(env.DB, account.id, allowanceFromSubscription(subscription({ tier: "pro" })));
    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({ audio_seconds: 45 * 3600, assistant_sessions: 15, source: "pro" });
  });
});

/**
 * The claim this whole slice rests on: nothing changes for anybody yet.
 *
 * The tables and the rules exist, and no account's allowance moves until the
 * webhook in slice 4b writes a row. These tests are what would fail if this
 * PR had quietly become an entitlement change.
 */
describe("no account's allowance changes until a webhook writes one", () => {
  it("still gives an account with no subscription the trial", async () => {
    const { account, token, deviceId } = await claimDevice("untouched@example.com");
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", 600);
    const body = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(body.source).toBe("trial");
    expect(body.audio_seconds.allowance).toBe(TRIAL_ALLOWANCE.audio_seconds);
    expect(body.summary_tokens.allowance).toBe(TRIAL_ALLOWANCE.summary_tokens);
  });

  it("still gives the trial to an account that HAS a subscription row", async () => {
    // A subscription alone entitles nothing. The proxy reads allowances, and
    // only the webhook writes there. Until 4b lands, a Pro row is inert.
    const { account, token } = await claimDevice("subscribed@example.com");
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_inert",
      account_id: account.id,
      stripe_customer_id: "cus_inert",
      price_id: "price_test_pro",
      tier: "pro",
      status: "active",
      current_period_end: new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString(),
      cancel_at_period_end: 0,
    });
    const body = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(body.source).toBe("trial");
    expect(body.audio_seconds.allowance).toBe(TRIAL_ALLOWANCE.audio_seconds);
  });

  it("reads the allowance an account is given once one is written", async () => {
    const { account, token } = await claimDevice("granted@example.com");
    await db.putAllowance(env.DB, account.id, allowanceFromSubscription(subscription({ tier: "standard" })));
    const body = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(body.source).toBe("standard");
    expect(body.audio_seconds.allowance).toBe(30 * 3600);
  });

  it("leaves a lapsed account able to spend nothing", async () => {
    const { account, token } = await claimDevice("lapsed@example.com");
    await db.putAllowance(env.DB, account.id, allowanceFromSubscription(subscription({ status: "canceled" })));
    const body = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(body.source).toBe("lapsed");
    expect(body.audio_seconds.allowance).toBe(0);
    expect(body.recordable_seconds).toBe(0);
  });
});
