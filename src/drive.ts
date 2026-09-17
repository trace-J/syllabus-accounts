/**
 * Google Drive, granted to the account rather than to one Mac.
 *
 *   GET  /drive/connect      (session) sends the person to Google for the
 *                            drive.file scope; the grant lands on the account
 *   POST /drive/token        (device bearer) a one-hour access token, minted
 *                            from the account's refresh token
 *   GET  /drive/status       (session or bearer) whether a grant exists
 *   POST /drive/disconnect   (session) revoke it at Google and forget it
 *
 * The consent comes back through the same /oauth2/callback the sign-in uses
 * (google.ts hands a "drive" flow to finishConnect here), so the Web client
 * needs no second redirect URI. The refresh token is encrypted under
 * DRIVE_KEY and never leaves this service; panels only ever see access
 * tokens, which expire within the hour.
 */

import { Hono, type Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { decrypt, encrypt } from "./crypto";
import * as db from "./db";
import type { AppEnv } from "./env";
import { AUTH_URL, TOKEN_URL, checkClaims, decodeClaims, redirectUri, type Flow } from "./google";
import { page } from "./pages";
import { browserOnly, sameOrigin } from "./session";
import { randomId } from "./util";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FLOW_COOKIE = "syllabus_accounts_signin";
const FLOW_SECONDS = 600;

export const drive = new Hono<AppEnv>();

drive.get("/drive/connect", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=" + encodeURIComponent("/drive/connect"));
  const flow: Flow = { state: randomId(18), nonce: randomId(18), next: "/", t: Date.now(), kind: "drive" };
  await setSignedCookie(c, FLOW_COOKIE, JSON.stringify(flow), c.env.SESSION_SECRET, {
    path: "/",
    httpOnly: true,
    secure: c.env.PUBLIC_URL.startsWith("https://"),
    sameSite: "Lax",
    maxAge: FLOW_SECONDS,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c.env.PUBLIC_URL),
    response_type: "code",
    scope: `openid email ${DRIVE_SCOPE}`,
    state: flow.state,
    nonce: flow.nonce,
    // A refresh token is only issued with offline access, and only reliably
    // when consent is asked for again; the hint keeps the picker on the
    // account they signed in with.
    access_type: "offline",
    prompt: "consent",
    login_hint: account.email,
  });
  return c.redirect(`${AUTH_URL}?${params}`);
});

/** The second half of /drive/connect, called from the shared callback. */
export async function finishConnect(c: Context<AppEnv>, flow: Flow, code: string) {
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=" + encodeURIComponent("/drive/connect"));
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(c.env.PUBLIC_URL),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const body = (await res.json()) as { refresh_token?: string; id_token?: string; scope?: string };
    if (!body.id_token) throw new Error("token endpoint returned no ID token");
    const claims = decodeClaims(body.id_token);
    checkClaims(claims, c.env.GOOGLE_CLIENT_ID, flow.nonce);
    if (!(body.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
      return c.html(page("Google Drive", "<p>Google Drive access was not granted. Tick the Drive box when Google asks.</p><p><a href='/drive/connect'>Try again</a></p>"), 400);
    }
    if (!body.refresh_token) {
      return c.html(page("Google Drive", "<p>Google did not return a lasting grant. Try again; if it keeps happening, remove Syllabus under your Google account's third-party access and connect once more.</p><p><a href='/drive/connect'>Try again</a></p>"), 400);
    }
    await db.putDriveGrant(c.env.DB, account.id, await encrypt(c.env.DRIVE_KEY, body.refresh_token), body.scope ?? DRIVE_SCOPE, (claims.email ?? "").toLowerCase());
    console.log(`drive connected for ${account.email} (${claims.email})`);
  } catch (err) {
    console.log(`drive connect failed: ${(err as Error).message}`);
    return c.html(page("Google Drive", "<p>The Drive connection could not be completed with Google.</p><p><a href='/drive/connect'>Try again</a></p>"), 502);
  }
  return c.redirect("/");
}

export function grantShape(grant: db.DriveGrant | null) {
  if (!grant) return { connected: false };
  return {
    connected: !grant.revoked_at,
    google_email: grant.google_email,
    granted_at: grant.granted_at,
    revoked_at: grant.revoked_at,
    revoked_reason: grant.revoked_reason,
  };
}

drive.get("/drive/status", async (c) => {
  const account = c.get("account");
  if (!account) return c.json({ error: "not_signed_in" }, 401);
  return c.json(grantShape(await db.driveGrant(c.env.DB, account.id)));
});

drive.post("/drive/token", async (c) => {
  const account = c.get("account");
  const device = c.get("device");
  if (!account || !device) return c.json({ error: "not_a_device" }, 401);
  const grant = await db.driveGrant(c.env.DB, account.id);
  if (!grant) return c.json({ error: "no_grant" }, 404);
  if (grant.revoked_at) return c.json({ error: "grant_revoked", reason: grant.revoked_reason }, 409);
  let refreshToken: string;
  try {
    refreshToken = await decrypt(c.env.DRIVE_KEY, grant.refresh_token_enc);
  } catch {
    console.log(`drive grant for ${account.email} cannot be decrypted; DRIVE_KEY changed?`);
    return c.json({ error: "grant_unreadable" }, 500);
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; scope?: string; error?: string };
  if (res.status === 400 && body.error === "invalid_grant") {
    await db.markDriveGrantRevoked(c.env.DB, account.id, "Google no longer honors the grant");
    console.log(`drive grant for ${account.email} was revoked at Google`);
    return c.json({ error: "grant_revoked", reason: "Google no longer honors the grant" }, 409);
  }
  if (!res.ok || !body.access_token) {
    console.log(`drive token refresh for ${account.email} failed: ${res.status} ${body.error ?? ""}`);
    return c.json({ error: "google_unavailable", status: res.status }, 502);
  }
  return c.json({
    access_token: body.access_token,
    expires_in: body.expires_in ?? 3600,
    scope: body.scope ?? grant.scopes,
    google_email: grant.google_email,
  });
});

drive.post("/drive/disconnect", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  const grant = await db.driveGrant(c.env.DB, account.id);
  if (grant && !grant.revoked_at) {
    try {
      const token = await decrypt(c.env.DRIVE_KEY, grant.refresh_token_enc);
      await fetch(REVOKE_URL + "?" + new URLSearchParams({ token }), { method: "POST" });
    } catch (err) {
      console.log(`could not revoke the drive grant at Google: ${(err as Error).message}`);
    }
  }
  await db.deleteDriveGrant(c.env.DB, account.id);
  return c.redirect("/");
});
