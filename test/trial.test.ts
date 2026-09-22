import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { TIERS, TOPUP, TRIAL_ALLOWANCE } from "../src/tiers";
import { claimDevice, get, ORIGIN, postForm, signedInAs } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(answer: (url: string, body: URLSearchParams, init: RequestInit) => Response) {
  const seen: { url: string; body: URLSearchParams; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      seen.push({ url, body, method: String(init.method ?? "GET") });
      return answer(url, body, init);
    }),
  );
  return seen;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function sign(payload: string, at = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("whsec_test_secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${at},v1=${hex}`;
}

async function deliver(event: unknown) {
  const raw = JSON.stringify(event);
  return SELF.fetch(ORIGIN + "/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": await sign(raw) },
    body: raw,
  });
}

let n = 0;
const nextId = () => `evt_t${++n}_${Math.random().toString(36).slice(2, 7)}`;

describe("the trial is 5 hours, with a card behind it", () => {
  it("asks for a card and sets a long Stripe trial", async () => {
    const { cookie } = await signedInAs("trialist@example.com");
    const sent = calls(() => json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    await postForm("/billing/checkout", { tier: "standard" }, { Cookie: cookie });
    const body = sent[0].body;
    // A trial owes nothing today, so Stripe only collects a card when told to
    // always collect one.
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("subscription_data[trial_period_days]")).toBe("90");
  });

  it("gives a trialing subscription the 5 hours, not the plan", async () => {
    const { account, token } = await claimDevice("in-trial@example.com");
    await db.linkStripeCustomer(env.DB, "cus_intrial", account.id);
    await deliver({
      id: nextId(),
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_intrial", object: "subscription", customer: "cus_intrial", status: "trialing",
          cancel_at_period_end: false, metadata: {},
          items: { data: [{ id: "si_1", price: { id: "price_test_pro" }, current_period_end: Math.floor(Date.now() / 1000) + 90 * 86400 }] },
        },
      },
    });

    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({ audio_seconds: TRIAL_ALLOWANCE.audio_seconds, source: "trial" });
    // Pro's 45 hours are not granted until the card is charged.
    expect(row?.audio_seconds).not.toBe(TIERS.pro.audio_seconds);

    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.audio_seconds.allowance).toBe(5 * 3600);
  });

  it("gives the plan's hours the moment Stripe says the trial is over", async () => {
    const { account } = await signedInAs("converted@example.com");
    await db.linkStripeCustomer(env.DB, "cus_converted", account.id);
    const sub = (status: string) => ({
      id: nextId(),
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_converted", object: "subscription", customer: "cus_converted", status,
          cancel_at_period_end: false, metadata: {},
          items: { data: [{ id: "si_1", price: { id: "price_test_standard" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
        },
      },
    });
    await deliver(sub("trialing"));
    expect((await db.allowance(env.DB, account.id))?.audio_seconds).toBe(TRIAL_ALLOWANCE.audio_seconds);
    await deliver(sub("active"));
    expect(await db.allowance(env.DB, account.id)).toMatchObject({
      audio_seconds: TIERS.standard.audio_seconds,
      source: "standard",
    });
  });

  it("redeeming a code takes no trial and asks for no card", async () => {
    const { cookie } = await signedInAs("coded@example.com");
    const sent = calls(() => json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    await postForm("/billing/checkout", { tier: "pro", redeem: "1" }, { Cookie: cookie });
    const body = sent[0].body;
    expect(body.get("payment_method_collection")).toBe("if_required");
    expect(body.get("subscription_data[trial_period_days]")).toBeNull();
    // Still a promotion code field, which is the whole point of this path.
    expect(body.get("allow_promotion_codes")).toBe("true");
  });
});

describe("spending the trial ends it", () => {
  /** An account mid-trial with `used` seconds already spent. */
  async function inTrial(email: string, used: number) {
    const claimed = await claimDevice(email);
    await db.putAllowance(env.DB, claimed.account.id, {
      audio_seconds: TRIAL_ALLOWANCE.audio_seconds,
      summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
      assistant_sessions: 0,
      source: "trial",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: `sub_${email.split("@")[0]}`,
      account_id: claimed.account.id,
      stripe_customer_id: `cus_${email}`,
      price_id: env.STRIPE_PRICE_STANDARD,
      tier: "standard",
      status: "trialing",
      current_period_end: new Date(Date.now() + 80 * 864e5).toISOString(),
      cancel_at_period_end: 0,
    });
    if (used > 0) await db.recordUsage(env.DB, claimed.account.id, claimed.deviceId, "transcribe", used);
    return claimed;
  }

  it("tells Stripe to end the trial now, once the hours are gone", async () => {
    const { account } = await inTrial("spent@example.com", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({ id: "sub_spent", status: "active" }));

    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain("/v1/subscriptions/sub_spent");
    expect(sent[0].body.get("trial_end")).toBe("now");
  });

  it("leaves a trial alone while there are hours left in it", async () => {
    const { account } = await inTrial("mid-trial@example.com", 3600);
    const sent = calls(() => json({}));
    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(0);
  });

  it("does not touch an account that never went through checkout", async () => {
    // No allowance row at all is the free trial, which has no card and no
    // subscription to end.
    const { account } = await claimDevice("no-checkout@example.com");
    await db.recordUsage(env.DB, account.id, "dev", "transcribe", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({}));
    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(0);
  });

  it("asks once, not once per chunk, while Stripe catches up", async () => {
    const { account } = await inTrial("chatty@example.com", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({ status: "active" }));
    const { endTrialIfSpent } = await import("../src/stripe");
    // A lecture uploads as many chunks, and each one settles.
    await endTrialIfSpent(env, account.id);
    await endTrialIfSpent(env, account.id);
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(1);
  });

  it("leaves the account where it is when Stripe will not answer", async () => {
    const { account } = await inTrial("stripe-down@example.com", TRIAL_ALLOWANCE.audio_seconds);
    calls(() => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }));
    const { endTrialIfSpent } = await import("../src/stripe");
    await expect(endTrialIfSpent(env, account.id)).resolves.toBeUndefined();
    // Still the trial, still refused by the proxy, and nothing granted here.
    expect((await db.allowance(env.DB, account.id))?.source).toBe("trial");
  });
});

describe("a top-up is bought once and counted once", () => {
  it("starts a one-time payment, not a subscription change", async () => {
    const { account, cookie } = await signedInAs("topper@example.com");
    await db.linkStripeCustomer(env.DB, "cus_topper", account.id);
    const sent = calls(() => json({ id: "cs_top", url: "https://checkout.stripe.com/top" }));

    const res = await postForm("/billing/topup", {}, { Cookie: cookie });
    expect(res.status).toBe(303);
    expect(sent[0].body.get("mode")).toBe("payment");
    expect(sent[0].body.get("line_items[0][price]")).toBe(env.STRIPE_PRICE_TOPUP);
    // A payment session has no subscription to stamp, so the session's own
    // metadata is the only thing that names the account.
    expect(sent[0].body.get("metadata[account_id]")).toBe(account.id);
    expect(sent[0].body.get("metadata[kind]")).toBe("topup");
  });

  it("grants the hours when Stripe says the payment went through", async () => {
    const { account, token } = await claimDevice("topped@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds,
      summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0,
      source: "starter",
    });

    await deliver({
      id: nextId(),
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_topup_1", object: "checkout.session", mode: "payment", payment_status: "paid",
          customer: "cus_topped", client_reference_id: account.id,
        },
      },
    });

    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.audio_seconds.allowance).toBe(TIERS.starter.audio_seconds + TOPUP.audio_seconds);
    expect(usage.summary_tokens.allowance).toBe(TIERS.starter.summary_tokens + TOPUP.summary_tokens);
    expect(usage.topped_up).toBe(true);
    // The plan itself did not change. The top-up sits beside it.
    expect((await db.allowance(env.DB, account.id))?.audio_seconds).toBe(TIERS.starter.audio_seconds);
  });

  it("grants nothing for a session that was never paid", async () => {
    const { account } = await signedInAs("unpaid-top@example.com");
    await deliver({
      id: nextId(),
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_topup_unpaid", object: "checkout.session", mode: "payment", payment_status: "unpaid",
          customer: "cus_unpaid", client_reference_id: account.id,
        },
      },
    });
    expect(await db.topupsThisPeriod(env.DB, account.id)).toEqual({ audio_seconds: 0, summary_tokens: 0 });
  });

  it("cannot be granted twice by the same session id", async () => {
    const { account } = await signedInAs("double-top@example.com");
    const first = await db.recordTopup(env.DB, "cs_same", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens);
    const second = await db.recordTopup(env.DB, "cs_same", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(TOPUP.audio_seconds);
  });

  it("survives the allowance being recomputed by a renewal", async () => {
    // The row is rewritten every time Stripe says anything about the
    // subscription. Hours somebody paid for must not go with it.
    const { account } = await signedInAs("renewed@example.com");
    await db.linkStripeCustomer(env.DB, "cus_renewed", account.id);
    await db.recordTopup(env.DB, "cs_before_renewal", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens);
    await deliver({
      id: nextId(),
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_renewed", object: "subscription", customer: "cus_renewed", status: "active",
          cancel_at_period_end: false, metadata: {},
          items: { data: [{ id: "si_1", price: { id: "price_test_starter" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
        },
      },
    });
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(TOPUP.audio_seconds);
  });

  it("belongs to the month it was bought in", async () => {
    const { account } = await signedInAs("last-month@example.com");
    await db.recordTopup(env.DB, "cs_old", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens, "2026-01");
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(0);
    expect((await db.topupsThisPeriod(env.DB, account.id, "2026-01")).audio_seconds).toBe(TOPUP.audio_seconds);
  });

  it("is not offered while there is no price for it", async () => {
    const real = env.STRIPE_PRICE_TOPUP;
    try {
      env.STRIPE_PRICE_TOPUP = "";
      const { cookie } = await signedInAs("no-topup-price@example.com");
      const sent = calls(() => json({}));
      const res = await postForm("/billing/topup", {}, { Cookie: cookie });
      expect(await res.text()).toContain("not switched on yet");
      expect(sent).toHaveLength(0);
    } finally {
      env.STRIPE_PRICE_TOPUP = real;
    }
  });
});

describe("a topped-up account can actually record again", () => {
  it("lets through audio the plan alone would refuse", async () => {
    const { account, token, deviceId } = await claimDevice("recovered@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: 600,
      summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
      assistant_sessions: 0,
      source: "starter",
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", 600);

    // Capped: the plan is spent to the second.
    const before = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(before.audio_seconds.left).toBe(0);
    expect(before.recordable_seconds).toBe(0);

    await db.recordTopup(env.DB, "cs_recover", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens);

    const after = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(after.audio_seconds.left).toBe(TOPUP.audio_seconds);
    expect(after.recordable_seconds).toBeGreaterThan(0);
    expect(after.topped_up).toBe(true);
  });
});

describe("what the page says about all of this", () => {
  it("promises the trial before the card is charged", async () => {
    const { cookie } = await signedInAs("page-trial@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Every plan starts with 5 hours to try");
    expect(html).toContain("Redeem a code");
  });

  it("says the plan is starting once the trial hours are gone", async () => {
    const { account, cookie, deviceId } = await claimDevice("page-spent@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TRIAL_ALLOWANCE.audio_seconds,
      summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
      assistant_sessions: 0,
      source: "trial",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_page_spent", account_id: account.id, stripe_customer_id: "cus_page_spent",
      price_id: env.STRIPE_PRICE_PRO, tier: "pro", status: "trialing",
      current_period_end: new Date(Date.now() + 80 * 864e5).toISOString(), cancel_at_period_end: 0,
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TRIAL_ALLOWANCE.audio_seconds);

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("trial hours are used up");
    expect(html).toContain("Pro</strong> is starting now");
    // Not a top-up: the plan about to arrive is more hours for less money.
    expect(html).not.toContain("Add 5 hours");
  });

  it("offers the top-up to a capped subscriber, and says it is a hard stop", async () => {
    const { account, cookie, deviceId } = await claimDevice("page-capped@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds, summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0, source: "starter",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_page_capped", account_id: account.id, stripe_customer_id: "cus_page_capped",
      price_id: env.STRIPE_PRICE_STARTER, tier: "starter", status: "active",
      current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), cancel_at_period_end: 0,
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TIERS.starter.audio_seconds);

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Add 5 hours for $5");
    expect(html).toContain("nothing is being billed for going over");
  });

  it("counts a top-up exactly as the proxy counts it", async () => {
    // The one way this section is allowed to be wrong, and is not: a page
    // that says capped while the proxy would take another hour.
    const { account, cookie, deviceId } = await claimDevice("page-topped@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds, summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0, source: "starter",
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TIERS.starter.audio_seconds);
    await db.recordTopup(env.DB, "cs_page_top", account.id, TOPUP.audio_seconds, TOPUP.summary_tokens);

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("5 hours of it topped up");
    expect(html).toContain("5 hours left");
    expect(html).not.toContain("Add 5 hours for $5");
  });
});
