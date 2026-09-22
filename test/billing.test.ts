import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { TIERS } from "../src/tiers";
import { get, ORIGIN, postForm, signedInAs, claimDevice } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stripe, scripted. Records every call so a test can read what we sent. */
function stripeApi(answer: (url: string, body: URLSearchParams) => Response) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      calls.push({ url, body });
      return answer(url, body);
    }),
  );
  return calls;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_123";
const PORTAL_URL = "https://billing.stripe.com/p/session/bps_test_123";

describe("starting a checkout", () => {
  it("sends Stripe the price, and both ways of naming the account", async () => {
    const { account, cookie } = await signedInAs("buyer@example.com");
    const calls = stripeApi(() => json({ id: "cs_test_123", url: CHECKOUT_URL }));

    const res = await postForm("/billing/checkout", { tier: "standard" }, { Cookie: cookie });

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(CHECKOUT_URL);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/checkout/sessions");

    const sent = calls[0].body;
    expect(sent.get("mode")).toBe("subscription");
    expect(sent.get("line_items[0][price]")).toBe(env.STRIPE_PRICE_STANDARD);
    // Both, on purpose: the subscription's metadata is what a
    // customer.subscription.created carries when it beats the session here.
    expect(sent.get("client_reference_id")).toBe(account.id);
    expect(sent.get("subscription_data[metadata][account_id]")).toBe(account.id);
  });

  it("asks for an address, because Texas taxes this", async () => {
    const { cookie } = await signedInAs("taxed@example.com");
    const calls = stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    await postForm("/billing/checkout", { tier: "starter" }, { Cookie: cookie });
    expect(calls[0].body.get("automatic_tax[enabled]")).toBe("true");
    expect(calls[0].body.get("billing_address_collection")).toBe("required");
  });

  it("takes a promotion code on either path", async () => {
    // Whether a card is demanded differs between the trial and the redeem
    // path, and test/trial.test.ts is where that split is held. The code box
    // itself is on both.
    const { cookie } = await signedInAs("friend@example.com");
    const calls = stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    await postForm("/billing/checkout", { tier: "pro" }, { Cookie: cookie });
    await postForm("/billing/checkout", { tier: "pro", redeem: "1" }, { Cookie: cookie });
    expect(calls[0].body.get("allow_promotion_codes")).toBe("true");
    expect(calls[1].body.get("allow_promotion_codes")).toBe("true");
  });

  it("prefills the email for somebody Stripe has never met", async () => {
    const { cookie } = await signedInAs("firsttime@example.com");
    const calls = stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    await postForm("/billing/checkout", { tier: "starter" }, { Cookie: cookie });
    expect(calls[0].body.get("customer_email")).toBe("firsttime@example.com");
    expect(calls[0].body.get("customer")).toBeNull();
  });

  it("reuses the customer of somebody who has subscribed before", async () => {
    const { account, cookie } = await signedInAs("returning@example.com");
    await db.linkStripeCustomer(env.DB, "cus_returning", account.id);
    const calls = stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    await postForm("/billing/checkout", { tier: "pro" }, { Cookie: cookie });
    // One person, one Stripe customer: their card and their invoices stay in
    // one place across a resubscription.
    expect(calls[0].body.get("customer")).toBe("cus_returning");
    expect(calls[0].body.get("customer_email")).toBeNull();
    // Automatic tax on an existing customer needs permission to update them.
    expect(calls[0].body.get("customer_update[address]")).toBe("auto");
  });

  it("refuses a tier nobody sells", async () => {
    const { cookie } = await signedInAs("chancer@example.com");
    const calls = stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    const res = await postForm("/billing/checkout", { tier: "platinum" }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not a plan we sell");
    expect(calls).toHaveLength(0);
  });

  it("says so plainly when Stripe will not start the session", async () => {
    const { cookie } = await signedInAs("unlucky@example.com");
    stripeApi(() => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 }));
    const res = await postForm("/billing/checkout", { tier: "starter" }, { Cookie: cookie });
    expect(await res.text()).toContain("Nothing was charged");
  });

  it("grants nothing on its own", async () => {
    // A checkout that Stripe accepts is still not a subscription. Only the
    // webhook writes an allowance, so this route must leave the account alone.
    const { account, cookie } = await signedInAs("nothing-yet@example.com");
    stripeApi(() => json({ id: "cs_1", url: CHECKOUT_URL }));
    await postForm("/billing/checkout", { tier: "pro" }, { Cookie: cookie });
    expect(await db.allowance(env.DB, account.id)).toBeNull();
    expect(await db.subscriptionsOf(env.DB, account.id)).toEqual([]);
  });
});

describe("who may buy", () => {
  it("sends a signed-out visitor to sign in", async () => {
    const res = await postForm("/billing/checkout", { tier: "starter" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/login");
  });

  it("refuses a panel's device token", async () => {
    // A device token sits on a laptop for months. Buying and canceling belong
    // to a person in a browser.
    const { token } = await claimDevice("panel-buyer@example.com");
    const res = await SELF.fetch(ORIGIN + "/billing/checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: new URLSearchParams({ tier: "pro" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a form posted from somewhere else", async () => {
    const { cookie } = await signedInAs("csrf@example.com");
    const res = await SELF.fetch(ORIGIN + "/billing/checkout", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.test" },
      body: new URLSearchParams({ tier: "pro" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("the billing portal", () => {
  it("opens Stripe's own page for a customer we know", async () => {
    const { account, cookie } = await signedInAs("manage@example.com");
    await db.linkStripeCustomer(env.DB, "cus_manage", account.id);
    const calls = stripeApi(() => json({ url: PORTAL_URL }));

    const res = await postForm("/billing/portal", {}, { Cookie: cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(PORTAL_URL);
    expect(calls[0].url).toContain("/v1/billing_portal/sessions");
    expect(calls[0].body.get("customer")).toBe("cus_manage");
  });

  it("says there is nothing to manage when nobody has ever paid", async () => {
    const { cookie } = await signedInAs("never-paid@example.com");
    const calls = stripeApi(() => json({ url: PORTAL_URL }));
    const res = await postForm("/billing/portal", {}, { Cookie: cookie });
    expect(await res.text()).toContain("never subscribed");
    expect(calls).toHaveLength(0);
  });

  it("does not blame the person when the portal is not configured in Stripe", async () => {
    const { account, cookie } = await signedInAs("unconfigured@example.com");
    await db.linkStripeCustomer(env.DB, "cus_unconfigured", account.id);
    stripeApi(
      () =>
        new Response(JSON.stringify({ error: { message: "No configuration provided" } }), { status: 400 }),
    );
    const res = await postForm("/billing/portal", {}, { Cookie: cookie });
    expect(await res.text()).toContain("Nothing has changed");
  });
});

describe("what the account page says about money", () => {
  it("offers the three plans to somebody on the trial", async () => {
    const { cookie } = await signedInAs("trial-view@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("free trial");
    expect(html).toContain("Choose Starter");
    expect(html).toContain("Choose Standard");
    expect(html).toContain("Choose Pro");
    expect(html).not.toContain("Manage billing");
  });

  it("names the plan and when it renews", async () => {
    const { account, cookie } = await signedInAs("subscriber-view@example.com");
    await db.linkStripeCustomer(env.DB, "cus_view", account.id);
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_view",
      account_id: account.id,
      stripe_customer_id: "cus_view",
      price_id: env.STRIPE_PRICE_STANDARD,
      tier: "standard",
      status: "active",
      current_period_end: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
      cancel_at_period_end: 0,
    });
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.standard.audio_seconds,
      summary_tokens: TIERS.standard.summary_tokens,
      assistant_sessions: 0,
      source: "standard",
    });

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Standard");
    expect(html).toContain("$15 a month");
    expect(html).toContain("Renews");
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("Choose Pro");
  });

  it("says a canceling subscription keeps its hours until it ends", async () => {
    const { account, cookie } = await signedInAs("leaving@example.com");
    await db.linkStripeCustomer(env.DB, "cus_leaving", account.id);
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_leaving",
      account_id: account.id,
      stripe_customer_id: "cus_leaving",
      price_id: env.STRIPE_PRICE_PRO,
      tier: "pro",
      status: "active",
      current_period_end: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      cancel_at_period_end: 1,
    });
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Ends");
    expect(html).toContain("keep these hours until then");
  });

  it("does not cut off a card Stripe is still retrying", async () => {
    const { account, cookie } = await signedInAs("retrying@example.com");
    await db.linkStripeCustomer(env.DB, "cus_retrying", account.id);
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_retrying",
      account_id: account.id,
      stripe_customer_id: "cus_retrying",
      price_id: env.STRIPE_PRICE_STARTER,
      tier: "starter",
      status: "past_due",
      current_period_end: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      cancel_at_period_end: 0,
    });
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("trying again");
    expect(html).toContain("Nothing has been cut off");
  });

  it("offers the plans again to somebody whose subscription ended", async () => {
    const { account, cookie } = await signedInAs("lapsed-view@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: 0,
      summary_tokens: 0,
      assistant_sessions: 0,
      source: "lapsed",
    });
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("has ended");
    expect(html).toContain("Choose Standard");
    expect(html).toContain("never touched");
  });

  it("reports hours against the same row the proxy enforces", async () => {
    const { account, cookie, deviceId } = await claimDevice("usage-view@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds,
      summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0,
      source: "starter",
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", 5 * 3600);
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("5 hours of 15 hours used this month");
    expect(html).toContain("10 hours left");
  });

  it("does not promise a plan just because Stripe sent the person back", async () => {
    // Coming back from Checkout is not the same as the webhook having landed.
    const { cookie } = await signedInAs("just-back@example.com");
    const html = await (await get("/?billing=done", { Cookie: cookie })).text();
    expect(html).toContain("can take a moment");
    expect(html).toContain("free trial");
  });

  it("says nothing happened when the person backed out", async () => {
    const { cookie } = await signedInAs("backed-out@example.com");
    const html = await (await get("/?billing=canceled", { Cookie: cookie })).text();
    expect(html).toContain("No change was made");
  });
});
