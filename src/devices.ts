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

import { Hono } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { approvedPage, devicePage } from "./pages";
import { sameOrigin } from "./session";
import { newDeviceToken, newUserCode, normalizeUserCode, plusSeconds, randomId, sha256Hex } from "./util";

export const CODE_SECONDS = 900;
export const POLL_INTERVAL = 5;
const PROFILES = new Set(["syllabus", "sous"]);

export const devices = new Hono<AppEnv>();

function tidyName(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 80);
}

devices.post("/device/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { profile?: string; name?: string };
  const profile = PROFILES.has(String(body.profile)) ? String(body.profile) : "syllabus";
  const name = tidyName(body.name);
  await db.sweepDeviceCodes(c.env.DB);

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
  const token = newDeviceToken();
  await db.insertDeviceToken(c.env.DB, await sha256Hex(token), pending.approved_device_id);
  const account = await db.accountById(c.env.DB, pending.approved_account_id);
  return c.json({
    token,
    account: account ? { id: account.id, email: account.email, name: account.name } : null,
    device: { id: pending.approved_device_id, name: pending.device_name || "A Mac", profile: pending.profile },
  });
});

/** From the account page: remove a Mac. Its token stops working at once. */
devices.post("/devices/:id/revoke", async (c) => {
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  await db.revokeDevice(c.env.DB, account.id, c.req.param("id"));
  return c.redirect("/");
});
