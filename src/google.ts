/**
 * Sign in with Google: plain OpenID Connect, with nothing but fetch.
 *
 *   /login            remembers where you were going, sends you to Google
 *   /oauth2/callback  trades the code for an ID token, checks it, sets the session
 *   /logout           clears the session
 *
 * The state and nonce ride in a short-lived signed cookie between the two.
 * The ID token arrives straight from Google's token endpoint over TLS, so
 * its signature is not re-checked here (OpenID Connect Core 3.1.3.7 allows
 * that for a token received over the direct token-endpoint connection); the
 * issuer, audience, expiry, nonce, and email_verified claims are.
 */

import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { upsertAccount } from "./db";
import type { AppEnv } from "./env";
import { page } from "./pages";
import { clearSession, setSession } from "./session";
import { fromBase64Url, randomId } from "./util";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALLBACK_PATH = "/oauth2/callback";

const FLOW_COOKIE = "syllabus_accounts_signin";
const FLOW_SECONDS = 600;

type Flow = { state: string; nonce: string; next: string; t: number };

/** A path on this site to return to after signing in, never elsewhere. */
export function safeNext(value: string | undefined): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

export function redirectUri(publicUrl: string): string {
  return publicUrl.replace(/\/$/, "") + CALLBACK_PATH;
}

export type IdClaims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export function decodeClaims(idToken: string): IdClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("ID token is not a JWT");
  const json = new TextDecoder().decode(fromBase64Url(parts[1]));
  return JSON.parse(json) as IdClaims;
}

/** Throws with a reason when the claims are not a fresh Google token for us. */
export function checkClaims(claims: IdClaims, clientId: string, nonce: string, nowSeconds = Date.now() / 1000): void {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error(`unexpected issuer ${claims.iss}`);
  }
  if (claims.aud !== clientId) throw new Error("token was issued for another client");
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) throw new Error("token has expired");
  if (claims.nonce !== nonce) throw new Error("nonce does not match the sign-in that was started");
  if (!claims.sub) throw new Error("token names no subject");
  if (!claims.email || !claims.email_verified) throw new Error("account has no verified email");
}

export const google = new Hono<AppEnv>();

google.get("/login", async (c) => {
  const flow: Flow = { state: randomId(18), nonce: randomId(18), next: safeNext(c.req.query("next")), t: Date.now() };
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
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    prompt: "select_account",
  });
  return c.redirect(`${AUTH_URL}?${params}`);
});

google.get(CALLBACK_PATH, async (c) => {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, FLOW_COOKIE);
  let flow: Flow | null = null;
  try {
    flow = raw ? (JSON.parse(raw) as Flow) : null;
  } catch {
    flow = null;
  }
  if (!flow || Date.now() - flow.t > FLOW_SECONDS * 1000 || c.req.query("state") !== flow.state) {
    return c.html(page("Sign in", "<p>That sign-in took too long or did not start here.</p><p><a href='/login'>Try again</a></p>"), 400);
  }
  if (c.req.query("error")) {
    return c.html(page("Sign in", "<p>Google did not complete the sign-in.</p><p><a href='/login'>Try again</a></p>"), 400);
  }
  const code = c.req.query("code") ?? "";
  if (!code) {
    return c.html(page("Sign in", "<p>Google sent no code back.</p><p><a href='/login'>Try again</a></p>"), 400);
  }

  let claims: IdClaims;
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
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error("token endpoint returned no ID token");
    claims = decodeClaims(body.id_token);
    checkClaims(claims, c.env.GOOGLE_CLIENT_ID, flow.nonce);
  } catch (err) {
    console.log(`sign-in failed: ${(err as Error).message}`);
    return c.html(page("Sign in", "<p>The sign-in could not be checked with Google.</p><p><a href='/login'>Try again</a></p>"), 502);
  }

  const account = await upsertAccount(c.env.DB, {
    sub: claims.sub,
    email: claims.email!.toLowerCase(),
    name: claims.name ?? "",
    picture: claims.picture ?? "",
  });
  console.log(`signed in: ${account.email}`);
  deleteCookie(c, FLOW_COOKIE, { path: "/" });
  await setSession(c, account.id);
  return c.redirect(flow.next);
});

google.on(["GET", "POST"], "/logout", (c) => {
  clearSession(c);
  deleteCookie(c, FLOW_COOKIE, { path: "/" });
  return c.html(page("Signed out", "<p>You are signed out.</p><p><a href='/login'>Sign in</a></p>"));
});
