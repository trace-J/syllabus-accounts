/**
 * Syllabus accounts: a Cloudflare Worker with a D1 database.
 *
 * Who is signed in comes from one of two places. A browser carries the
 * session cookie set by the Google sign-in (google.ts). A panel running on
 * somebody's Mac carries a device token as a bearer (devices.ts). Either
 * way the handlers see c.var.account, and a panel also sees c.var.device.
 *
 * Which of the two it was is c.var.authKind, and routes that administer the
 * account rather than serve a panel say so with browserOnly(). Sharing one
 * c.var.account between the two kinds is what let a stolen device token
 * enroll a replacement Mac and remove the one it was stolen from.
 */

import { Hono } from "hono";
import * as db from "./db";
import { devices } from "./devices";
import type { AppEnv } from "./env";
import { google } from "./google";
import { accountPage, landing, privacyPage, termsPage } from "./pages";
import { proxy } from "./proxy";
import { panelUrl, relay, relayState } from "./relay";
import { settings } from "./settings";
import { stripeHooks } from "./stripe";
import { drive } from "./drive";
import { sessionMiddleware } from "./session";
import { DEVICE_TOKEN_PREFIX, sha256Hex } from "./util";

const app = new Hono<AppEnv>();

// Mounted BEFORE the auth middleware, and deliberately.
//
// Stripe carries neither a session cookie nor a device token, so the
// middleware below has nothing to resolve for it. Hono runs handlers in the
// order they were registered, so registering this route first is what keeps
// the auth middleware off it: the webhook proves who it is with Stripe's
// signature over the raw body and with nothing else.
app.route("/", stripeHooks);

app.use("*", async (c, next) => {
  c.set("account", null);
  c.set("device", null);
  c.set("authKind", null);
  const auth = c.req.header("Authorization") ?? "";
  if (auth.startsWith("Bearer " + DEVICE_TOKEN_PREFIX)) {
    const found = await db.resolveDeviceToken(c.env.DB, await sha256Hex(auth.slice(7)));
    if (!found) return c.json({ error: "invalid_token" }, 401);
    c.set("account", found.account);
    c.set("device", found.device);
    c.set("authKind", "device");
    c.executionCtx.waitUntil(db.touchDevice(c.env.DB, found.device.id));
    return next();
  }
  return sessionMiddleware(c, next);
});

app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/privacy", (c) => c.html(privacyPage()));
app.get("/terms", (c) => c.html(termsPage()));

app.get("/", async (c) => {
  const account = c.get("account");
  if (!account) return c.html(landing());
  const devices = await db.devicesOf(c.env.DB, account.id);
  // Each Mac's relay object knows whether its panel is connected right now.
  const relays = Object.fromEntries(
    await Promise.all(devices.map(async (d) => [d.id, await relayState(c.env, d.id).catch(() => null)] as const)),
  );
  return c.html(accountPage(account, devices, await db.driveGrant(c.env.DB, account.id), relays, c.env.PUBLIC_URL));
});

/** Who am I: for a panel checking its token, or a browser checking its session. */
app.get("/me", (c) => {
  const account = c.get("account");
  if (!account) return c.json({ error: "not_signed_in" }, 401);
  const device = c.get("device");
  return c.json({
    account: { id: account.id, email: account.email, name: account.name },
    device: device ? { id: device.id, name: device.name, profile: device.profile } : null,
  });
});

/** A panel signing itself out: its own token stops working. */
app.post("/device/revoke", async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 401);
  const auth = c.req.header("Authorization") ?? "";
  await db.revokeDeviceToken(c.env.DB, await sha256Hex(auth.slice(7)));
  return c.json({ ok: true });
});

app.route("/", google);
app.route("/", devices);
app.route("/", relay);
app.route("/", settings);
app.route("/", drive);
app.route("/", proxy);

app.notFound((c) => c.text("Not found", 404));
app.onError((err, c) => {
  console.log(`error: ${err.message}`);
  return c.text("Something went wrong", 500);
});

export default app;
// The Durable Object class has to be exported from the entry module.
export { PanelRelay } from "./panel-relay";
