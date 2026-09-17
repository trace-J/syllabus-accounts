/**
 * Claiming a panel: the device-code flow (RFC 8628, trimmed to what we need).
 *
 *   POST /device/start    the panel asks for a code; gets device_code + user_code
 *   GET  /device?code=    the person, signed in, sees the code and confirms
 *   POST /device/approve  ties the code to their account, creates the device
 *   POST /device/poll     the panel, polling with device_code, receives its token
 *
 * The panel never sees a browser cookie and the browser never sees the
 * device token: the code is the only thing that crosses between them, and it
 * is typed by a person. The token is minted at collection time, so it exists
 * in plain form only in the one response that carries it.
 */

import { Hono, type Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { approvedPage, devicePage } from "./pages";
import { browserOnly, sameOrigin } from "./session";
import { newDeviceToken, newUserCode, normalizeUserCode, plusSeconds, randomId, sha256Hex } from "./util";

export const CODE_SECONDS = 900;
export const POLL_INTERVAL = 5;
const PROFILES = new Set(["syllabus", "sous"]);

/**
 * What the two open routes allow, and why they need anything at all.
 *
 * /device/start and /device/poll are the only routes here that answer before
 * anybody has proved who they are; the per-account limits protecting the rest
 * of the service have nothing to key on. Unlimited, /device/start is a free
 * way to make this service write a database row per request and to churn the
 * user-code space that people read off a screen.
 *
 * A real panel starts one claim per sign-in and polls it every POLL_INTERVAL
 * seconds until a person types the code, so the limits below are far above
 * anything a Mac does and only bite on a script. They are keyed by source
 * address, which is a weak identifier that costs an attacker something to
 * vary; PENDING_CAP is the backstop that does not depend on the key at all.
 */
const START_LIMIT = 10;
const START_WINDOW_SECONDS = 600;
const POLL_LIMIT = 60;
const POLL_WINDOW_SECONDS = 60;
const PENDING_CAP = 500;

/** Who is asking, as well as this can be known at the edge. */
function source(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(c: Context<AppEnv>, limit: number, windowSeconds: number, retryAfter: number) {
  return c.json({ error: "rate_limited", limit, window_seconds: windowSeconds }, 429, {
    "Retry-After": String(retryAfter),
  });
}

export const devices = new Hono<AppEnv>();

function tidyName(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 80);
}

devices.post("/device/start", async (c) => {
  const gate = await db.hitRateLimit(c.env.DB, `device-start:${source(c)}`, START_LIMIT, START_WINDOW_SECONDS);
  if (!gate.allowed) return rateLimited(c, START_LIMIT, START_WINDOW_SECONDS, gate.retryAfter);

  const body = (await c.req.json().catch(() => ({}))) as { profile?: string; name?: string };
  const profile = PROFILES.has(String(body.profile)) ? String(body.profile) : "syllabus";
  const name = tidyName(body.name);
  await db.sweepDeviceCodes(c.env.DB);
  // Expired windows are of no further use and this is the quietest route
  // that runs often enough to clear them.
  await db.sweepRateLimits(c.env.DB, Math.floor(Date.now() / 1000) - 3 * START_WINDOW_SECONDS);

  // The limit above is per source; this one is not, so a spread-out flood
  // still cannot fill the table or exhaust the codes people have to read.
  if ((await db.pendingDeviceCodes(c.env.DB)) >= PENDING_CAP) {
    console.log(`device/start refused: ${PENDING_CAP} claims already pending`);
    return c.json({ error: "too_many_pending" }, 503, { "Retry-After": String(CODE_SECONDS) });
  }

  const deviceCode = randomId(32);
  let userCode = newUserCode();
  // A collision on a 32^8 space is unlikely; the unique index makes it impossible.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await db.deviceCodeByUserCode(c.env.DB, userCode))) break;
    userCode = newUserCode();
  }
  await db.insertDeviceCode(c.env.DB, await sha256Hex(deviceCode), userCode, profile, name, plusSeconds(CODE_SECONDS));
  const verify = `${c.env.PUBLIC_URL}/device`;
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verify,
    verification_uri_complete: `${verify}?code=${encodeURIComponent(userCode)}`,
    expires_in: CODE_SECONDS,
    interval: POLL_INTERVAL,
  });
});

devices.get("/device", async (c) => {
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=" + encodeURIComponent(c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "")));
  const code = normalizeUserCode(c.req.query("code") ?? "");
  let deviceName = "";
  if (code) {
    const pending = await db.deviceCodeByUserCode(c.env.DB, code);
    if (pending && pending.expires_at > new Date().toISOString() && !pending.approved_account_id) deviceName = pending.device_name;
  }
  return c.html(devicePage(account, code, deviceName, ""));
});

devices.post("/device/approve", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=/device");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  const form = await c.req.parseBody();
  const typed = String(form.user_code ?? "");
  const code = normalizeUserCode(typed);
  if (!code) return c.html(devicePage(account, typed, "", "A code is four letters, a dash, and four more."), 400);

  const pending = await db.deviceCodeByUserCode(c.env.DB, code);
  if (!pending || pending.expires_at < new Date().toISOString()) {
    return c.html(devicePage(account, code, "", "That code is not waiting to be connected. Ask Syllabus for a new one."), 400);
  }
  if (pending.approved_account_id) {
    return c.html(devicePage(account, code, "", "That code was already used."), 400);
  }
  const name = pending.device_name || "A Mac";
  const device = await db.createDevice(c.env.DB, account.id, name, pending.profile);
  const ok = await db.approveDeviceCode(c.env.DB, pending.device_code_hash, account.id, device.id);
  if (!ok) {
    await db.revokeDevice(c.env.DB, account.id, device.id);
    return c.html(devicePage(account, code, "", "That code was already used."), 400);
  }
  console.log(`device ${device.id} (${name}) joined ${account.email}`);
  return c.html(approvedPage(account, name));
});

devices.post("/device/poll", async (c) => {
  // slow_down rather than our own refusal: it is what RFC 8628 says a token
  // endpoint answers a client polling too fast, and a panel already handles
  // it by waiting longer (run_claim in intake/account.py). Anything else
  // reads to that loop as a refusal and abandons a claim that is still good,
  // which would turn a shared address into a sign-in that cannot finish.
  const gate = await db.hitRateLimit(c.env.DB, `device-poll:${source(c)}`, POLL_LIMIT, POLL_WINDOW_SECONDS);
  if (!gate.allowed) {
    return c.json({ error: "slow_down", interval: POLL_INTERVAL * 2 }, 400, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  const body = (await c.req.json().catch(() => ({}))) as { device_code?: string };
  const deviceCode = String(body.device_code ?? "");
  if (!deviceCode) return c.json({ error: "invalid_request" }, 400);
  const pending = await db.deviceCodeByHash(c.env.DB, await sha256Hex(deviceCode));
  if (!pending) return c.json({ error: "invalid_grant" }, 400);
  if (pending.expires_at < new Date().toISOString()) return c.json({ error: "expired_token" }, 400);
  if (!pending.approved_account_id || !pending.approved_device_id) {
    return c.json({ error: "authorization_pending", interval: POLL_INTERVAL }, 400);
  }
  if (!(await db.collectDeviceCode(c.env.DB, pending.device_code_hash))) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  const account = await db.accountById(c.env.DB, pending.approved_account_id);
  if (!account) return c.json({ error: "invalid_grant" }, 400);
  const token = newDeviceToken();
  await db.insertDeviceToken(c.env.DB, await sha256Hex(token), pending.approved_device_id, account.token_version);
  return c.json({
    token,
    account: { id: account.id, email: account.email, name: account.name },
    device: { id: pending.approved_device_id, name: pending.device_name || "A Mac", profile: pending.profile },
  });
});

/** From the account page: remove a Mac. Its token stops working at once. */
devices.post("/devices/:id/revoke", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  await db.revokeDevice(c.env.DB, account.id, c.req.param("id"));
  return c.redirect("/");
});

/**
 * From the account page: remove every Mac and orphan every token at once.
 *
 * What to reach for when a token may be in somebody else's hands and the list
 * of Macs can no longer be trusted to be the list you enrolled.
 */
devices.post("/devices/revoke-all", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  const removed = await db.revokeEverything(c.env.DB, account.id);
  console.log(`${account.email} signed out every Mac (${removed})`);
  return c.redirect("/");
});
