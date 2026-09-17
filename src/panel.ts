/**
 * Signing in to a panel over the web, through this service.
 *
 * A Syllabus panel published through a tunnel has no accounts of its own.
 * When a browser reaches it without a session, the panel sends the browser
 * here:
 *
 *   GET  /panel/authorize?device=&redirect_uri=&state=
 *        The person signs in (if they have not), and if their account owns
 *        that device, the browser goes back to redirect_uri with a one-time
 *        code and the state.
 *   POST /panel/exchange   {code}   (Authorization: Bearer syd_...)
 *        The panel trades the code for the account. Only the device the
 *        code was minted for can redeem it.
 *   POST /device/public-url {public_url}   (bearer)
 *        The panel tells us where it is published, so /panel/authorize
 *        only ever sends a browser back to that address.
 *
 * The panel then sets its own session cookie, as it always has; nothing
 * here needs to be reachable for the panel to keep honoring a session it
 * already issued.
 */

import { Hono } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { notYoursPage, page } from "./pages";
import { browserOnly } from "./session";
import { plusSeconds, randomId, sha256Hex } from "./util";

export const PANEL_CODE_SECONDS = 300;

export const panel = new Hono<AppEnv>();

/** An https address with no path, query, or fragment: where a panel is published. */
export function normalizePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return "";
  return url.origin;
}

/** Whether `redirectUri` is a callback on the panel published at `publicUrl`. */
export function redirectAllowed(publicUrl: string, redirectUri: string): boolean {
  if (!publicUrl) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return url.origin === publicUrl && !url.search && !url.hash && url.pathname.length > 1;
}

panel.post("/device/public-url", async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { public_url?: string };
  const publicUrl = normalizePublicUrl(String(body.public_url ?? ""));
  if (!publicUrl) return c.json({ error: "invalid_request", detail: "public_url must be an https origin" }, 400);
  await db.setDevicePublicUrl(c.env.DB, device.id, publicUrl);
  return c.json({ ok: true, public_url: publicUrl });
});

panel.get("/panel/authorize", async (c) => {
  // The panel sends its owner's browser here; the panel itself never follows
  // this link, and a token that did could mint a sign-in code for any Mac on
  // the account.
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const deviceId = c.req.query("device") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const state = c.req.query("state") ?? "";
  const account = c.get("account");
  if (!account) {
    const here = "/panel/authorize?" + new URLSearchParams({ device: deviceId, redirect_uri: redirectUri, state });
    return c.redirect("/login?next=" + encodeURIComponent(here));
  }
  if (!deviceId || !redirectUri || !state) {
    return c.html(page("Sign in", "<p>That link is missing something. Go back to Syllabus and try again.</p>"), 400);
  }
  const device = await db.deviceById(c.env.DB, deviceId);
  if (!device) {
    return c.html(page("Sign in", "<p>That Syllabus is not connected to any account. Its owner can connect it from its Setup page.</p>"), 404);
  }
  if (!redirectAllowed(device.public_url, redirectUri)) {
    console.log(`refused redirect to ${redirectUri} for device ${device.id} (registered ${device.public_url || "nothing"})`);
    return c.html(page("Sign in", "<p>That Syllabus has not told the account service where it is published, so the sign-in cannot be sent back to it. Restarting its panel usually fixes this.</p>"), 400);
  }
  if (device.account_id !== account.id) {
    console.log(`refused ${account.email} at device ${device.id}: belongs to another account`);
    return c.html(notYoursPage(account.email), 403);
  }
  await db.sweepPanelCodes(c.env.DB);
  const code = randomId(32);
  await db.insertPanelCode(c.env.DB, await sha256Hex(code), device.id, account.id, redirectUri, plusSeconds(PANEL_CODE_SECONDS));
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", state);
  return c.redirect(back.toString());
});

panel.post("/panel/exchange", async (c) => {
  const device = c.get("device");
  const account = c.get("account");
  if (!device || !account) return c.json({ error: "not_a_device" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const code = String(body.code ?? "");
  if (!code) return c.json({ error: "invalid_request" }, 400);
  const redeemed = await db.redeemPanelCode(c.env.DB, await sha256Hex(code), device.id);
  if (!redeemed) return c.json({ error: "invalid_grant" }, 400);
  const owner = redeemed.account_id === account.id ? account : await db.accountById(c.env.DB, redeemed.account_id);
  if (!owner) return c.json({ error: "invalid_grant" }, 400);
  return c.json({ account: { id: owner.id, email: owner.email, name: owner.name } });
});
