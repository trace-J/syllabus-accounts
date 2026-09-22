import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import { TRIAL_ALLOWANCE } from "../src/proxy";
import { TIERS } from "../src/tiers";
import { claimDevice, get, ORIGIN, signedInAs } from "./helpers";

const SECRET = "whsec_test_secret";

/** Stripe's signature header: an HMAC over `${timestamp}.${rawBody}`. */
async function sign(payload: string, at = Math.floor(Date.now() / 1000), secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${at},v1=${hex}`;
}

/** Deliver an event the way Stripe does: raw JSON plus a signature over it. */
async function deliver(event: unknown, over: { signature?: string; at?: number } = {}) {
  const raw = JSON.stringify(event);
  const signature = over.signature ?? (await sign(raw, over.at));
  return SELF.fetch(ORIGIN + "/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: raw,
  });
}

let events = 0;
function eventId() {
  events += 1;
  return `evt_${events}_${Math.random().toString(36).slice(2, 8)}`;
}

function subscriptionEvent(type: string, object: Record<string, unknown>) {
  return {
    id: eventId(),
    type,
    data: {
      object: {
        id: "sub_default",
        object: "subscription",
        customer: "cus_default",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [
            {
              id: "si_default",
              price: { id: "price_test_pro" },
              current_period_end: Math.floor(Date.now() / 1000) + 20 * 24 * 3600,
            },
          ],
        },
        ...object,
      },
    },
  };
}

function checkoutEvent(object: Record<string, unknown>) {
  return {
    id: eventId(),
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_default",
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_default",
        subscription: "sub_default",
        ...object,
      },
    },
  };
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("a delivery has to be from Stripe", () => {
  it("refuses everything while the secret is unset, rather than trusting it", async () => {
    const real = env.STRIPE_WEBHOOK_SECRET;
    try {
      env.STRIPE_WEBHOOK_SECRET = undefined;
      const res = await deliver(subscriptionEvent("customer.subscription.created", {}));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "stripe_not_configured" });
    } finally {
      env.STRIPE_WEBHOOK_SECRET = real;
    }
  });

  it("refuses a delivery with no signature at all", async () => {
    const res = await deliver(subscriptionEvent("customer.subscription.created", {}), { signature: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_signature" });
  });

  it("refuses a signature made with the wrong secret", async () => {
    const raw = JSON.stringify(subscriptionEvent("customer.subscription.created", {}));
    const forged = await sign(raw, undefined, "whsec_not_the_secret");
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": forged },
      body: raw,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_signature" });
  });

  it("refuses a body that was changed after it was signed", async () => {
    const original = JSON.stringify(subscriptionEvent("customer.subscription.created", {}));
    const signature = await sign(original);
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": signature },
      body: original.replace("price_test_pro", "price_test_starter"),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a correctly signed delivery that is too old to be live", async () => {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const res = await deliver(subscriptionEvent("customer.subscription.created", {}), { at: hourAgo });
    expect(res.status).toBe(400);
  });

  it("does not need a session cookie or a device token", async () => {
    // The proof that the route is mounted ahead of the auth middleware: no
    // credential of ours is sent, and the answer is about Stripe's signature.
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_signature" });
  });
});

describe("an event is handled once", () => {
  it("takes the first delivery and calls the second a duplicate", async () => {
    const { account } = await signedInAs("dupe@example.com");
    await db.linkStripeCustomer(env.DB, "cus_dupe", account.id);
    const event = subscriptionEvent("customer.subscription.created", {
      id: "sub_dupe",
      customer: "cus_dupe",
    });

    const first = await deliver(event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const second = await deliver(event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
  });

  it("does not apply a replayed event a second time", async () => {
    const { account } = await signedInAs("replay@example.com");
    await db.linkStripeCustomer(env.DB, "cus_replay", account.id);
    const event = subscriptionEvent("customer.subscription.created", {
      id: "sub_replay",
      customer: "cus_replay",
    });
    await deliver(event);

    // Stripe redelivers the same event id carrying different content. The id
    // is what is checked, so nothing moves.
    const tampered = structuredClone(event);
    (tampered.data.object as Record<string, unknown>).status = "canceled";
    const again = await deliver(tampered);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect((await db.subscriptionById(env.DB, "sub_replay"))?.status).toBe("active");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("holds no claim on an event it could not finish, so the retry works", async () => {
    // A subscription event that beat its own checkout session: nobody knows
    // whose customer this is yet.
    const event = subscriptionEvent("customer.subscription.created", {
      id: "sub_early",
      customer: "cus_early",
    });
    const early = await deliver(event);
    expect(early.status).toBe(500);
    expect(await early.json()).toEqual({ error: "retry_later" });

    // Stripe would give up if this were recorded as handled. It is not.
    const claimed = await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(event.id).first();
    expect(claimed).toBeNull();

    // The session lands, and Stripe's retry of the very same event works.
    const { account } = await signedInAs("early@example.com");
    await deliver(checkoutEvent({ customer: "cus_early", client_reference_id: account.id }));
    const retry = await deliver(event);
    expect(retry.status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });
});

describe("checkout tells us whose customer this is", () => {
  it("links the customer to the account and writes no allowance yet", async () => {
    const { account } = await signedInAs("checkout@example.com");
    const res = await deliver(
      checkoutEvent({ customer: "cus_checkout", client_reference_id: account.id }),
    );
    expect(res.status).toBe(200);
    expect(await db.accountIdForLinkedCustomer(env.DB, "cus_checkout")).toBe(account.id);
    // The session says nothing about price, status or period, so the
    // subscription's own event is what grants anything.
    expect(await db.allowance(env.DB, account.id)).toBeNull();
  });

  it("records the event against the account, so it can be found later", async () => {
    const { account } = await signedInAs("attributed-hook@example.com");
    const event = checkoutEvent({ customer: "cus_attributed", client_reference_id: account.id });
    await deliver(event);
    const row = await env.DB.prepare("SELECT account_id, type FROM stripe_events WHERE id = ?")
      .bind(event.id)
      .first<{ account_id: string; type: string }>();
    expect(row).toEqual({ account_id: account.id, type: "checkout.session.completed" });
  });

  it("defers a session that names no account, rather than losing it", async () => {
    const res = await deliver(checkoutEvent({ customer: "cus_nameless" }));
    expect(res.status).toBe(500);
  });

  it("stops retrying a session that names an account we do not have", async () => {
    const res = await deliver(
      checkoutEvent({ customer: "cus_ghost", client_reference_id: "no-such-account" }),
    );
    expect(res.status).toBe(200);
    expect(await db.accountIdForLinkedCustomer(env.DB, "cus_ghost")).toBeNull();
  });
});

describe("a subscription becomes an allowance", () => {
  it("grants the tier the price names, and the proxy reports it", async () => {
    const { account, token } = await claimDevice("grants@example.com");
    await deliver(checkoutEvent({ customer: "cus_grants", client_reference_id: account.id }));
    await deliver(
      subscriptionEvent("customer.subscription.created", { id: "sub_grants", customer: "cus_grants" }),
    );

    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({
      audio_seconds: TIERS.pro.audio_seconds,
      summary_tokens: TIERS.pro.summary_tokens,
      assistant_sessions: 15,
      source: "pro",
    });

    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.source).toBe("pro");
    expect(usage.audio_seconds.allowance).toBe(45 * 3600);
  });

  it("takes the account off the subscription's own metadata when Checkout stamped it", async () => {
    // No checkout session and no customer link: this is the path a
    // subscription created straight from the dashboard takes.
    const { account } = await signedInAs("stamped@example.com");
    const res = await deliver(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_stamped",
        customer: "cus_stamped",
        metadata: { account_id: account.id },
        items: { data: [{ id: "si_1", price: { id: "price_test_starter" } }] },
      }),
    );
    expect(res.status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("starter");
  });

  it("stores the period end off the item, where a current Stripe puts it", async () => {
    const { account } = await signedInAs("period@example.com");
    const ends = Math.floor(Date.parse("2026-11-17T00:00:00.000Z") / 1000);
    await deliver(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_period",
        customer: "cus_period",
        metadata: { account_id: account.id },
        items: { data: [{ id: "si_1", price: { id: "price_test_pro" }, current_period_end: ends }] },
      }),
    );
    expect((await db.subscriptionById(env.DB, "sub_period"))?.current_period_end).toBe(
      "2026-11-17T00:00:00.000Z",
    );
  });

  it("still reads a period end an older API version puts on the subscription", async () => {
    const { account } = await signedInAs("legacy-period@example.com");
    const ends = Math.floor(Date.parse("2026-12-01T00:00:00.000Z") / 1000);
    await deliver(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_legacy",
        customer: "cus_legacy",
        metadata: { account_id: account.id },
        current_period_end: ends,
        items: { data: [{ id: "si_1", price: { id: "price_test_pro" } }] },
      }),
    );
    expect((await db.subscriptionById(env.DB, "sub_legacy"))?.current_period_end).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  it("gives an unrecognized price the cheapest tier rather than nothing", async () => {
    const { account } = await signedInAs("unknown-price@example.com");
    await deliver(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_unknown",
        customer: "cus_unknown",
        metadata: { account_id: account.id },
        items: { data: [{ id: "si_1", price: { id: "price_live_not_configured" } }] },
      }),
    );
    const row = await db.allowance(env.DB, account.id);
    expect(row?.audio_seconds).toBe(TIERS.starter.audio_seconds);
    expect(row?.source).toBe("unknown");
    expect((await db.subscriptionById(env.DB, "sub_unknown"))?.price_id).toBe("price_live_not_configured");
  });
});

describe("what happens when it ends", () => {
  it("takes everything away when the subscription is deleted", async () => {
    const { account, token } = await claimDevice("ends@example.com");
    await deliver(checkoutEvent({ customer: "cus_ends", client_reference_id: account.id }));
    await deliver(subscriptionEvent("customer.subscription.created", { id: "sub_ends", customer: "cus_ends" }));
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");

    await deliver(
      subscriptionEvent("customer.subscription.deleted", {
        id: "sub_ends",
        customer: "cus_ends",
        status: "canceled",
      }),
    );

    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({ audio_seconds: 0, summary_tokens: 0, source: "lapsed" });
    // Not the trial. Handing that back would be five free hours a month for
    // as long as the account existed.
    expect(row?.audio_seconds).not.toBe(TRIAL_ALLOWANCE.audio_seconds);

    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.source).toBe("lapsed");
    expect(usage.recordable_seconds).toBe(0);
  });

  it("keeps paying while Stripe retries a card", async () => {
    const { account } = await signedInAs("past-due@example.com");
    await db.linkStripeCustomer(env.DB, "cus_pastdue", account.id);
    await deliver(
      subscriptionEvent("customer.subscription.updated", {
        id: "sub_pastdue",
        customer: "cus_pastdue",
        status: "past_due",
      }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("keeps paying a subscription that is set to cancel at the period end", async () => {
    const { account } = await signedInAs("will-cancel@example.com");
    await db.linkStripeCustomer(env.DB, "cus_willcancel", account.id);
    await deliver(
      subscriptionEvent("customer.subscription.updated", {
        id: "sub_willcancel",
        customer: "cus_willcancel",
        cancel_at_period_end: true,
      }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
    expect((await db.subscriptionById(env.DB, "sub_willcancel"))?.cancel_at_period_end).toBe(1);
  });
});

describe("an account with more than one subscription", () => {
  it("is on the better tier while both are live, whichever event arrives", async () => {
    const { account } = await signedInAs("upgrader@example.com");
    await db.linkStripeCustomer(env.DB, "cus_upgrade", account.id);
    await deliver(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_old_starter",
        customer: "cus_upgrade",
        items: { data: [{ id: "si_1", price: { id: "price_test_starter" } }] },
      }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("starter");

    await deliver(
      subscriptionEvent("customer.subscription.created", { id: "sub_new_pro", customer: "cus_upgrade" }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");

    // The Starter's own cancellation must not be what decides the account.
    await deliver(
      subscriptionEvent("customer.subscription.deleted", {
        id: "sub_old_starter",
        customer: "cus_upgrade",
        status: "canceled",
        items: { data: [{ id: "si_1", price: { id: "price_test_starter" } }] },
      }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });
});

describe("rows this webhook will not touch", () => {
  it("leaves the owner's hand-granted allowance alone", async () => {
    const { account } = await signedInAs("owner@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: 40 * 3600,
      summary_tokens: 1_500_000,
      assistant_sessions: 0,
      source: "owner",
    });
    await db.linkStripeCustomer(env.DB, "cus_owner", account.id);
    await deliver(
      subscriptionEvent("customer.subscription.deleted", {
        id: "sub_owner",
        customer: "cus_owner",
        status: "canceled",
      }),
    );

    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({ source: "owner", audio_seconds: 40 * 3600 });
    // The subscription is still recorded; only the allowance is protected.
    expect((await db.subscriptionById(env.DB, "sub_owner"))?.status).toBe("canceled");
  });
});

describe("events that are not about entitlement", () => {
  it("accepts and records one without writing anything", async () => {
    const event = { id: eventId(), type: "invoice.paid", data: { object: { id: "in_1", object: "invoice" } } };
    const countAllowances = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM allowances").first<{ n: number }>())?.n;
    const before = await countAllowances();
    const res = await deliver(event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Claimed, so a redelivery is cheap, and findable with no account against it.
    const row = await env.DB.prepare("SELECT account_id FROM stripe_events WHERE id = ?")
      .bind(event.id)
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe("");
    expect(await countAllowances()).toBe(before);
  });
});

describe("the body is bounded before anything is done with it", () => {
  it("refuses one that declares more than any real event", async () => {
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=deadbeef", "Content-Length": String(300 * 1024) },
      body: "x".repeat(300 * 1024),
    });
    expect(res.status).toBe(413);
  });
});
