/**
 * The browser session: a signed cookie naming the account, good for 30 days.
 *
 * The cookie holds nothing but the account id and when it was issued, signed
 * with SESSION_SECRET. Nothing is stored server-side per session, so signing
 * out everywhere is a matter of rotating the secret.
 */

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { accountById } from "./db";
import type { AppEnv } from "./env";

export const SESSION_COOKIE = "syllabus_accounts_session";
export const SESSION_DAYS = 30;

type SessionData = { a: string; t: number };

export async function setSession(c: Context<AppEnv>, accountId: string): Promise<void> {
  const data: SessionData = { a: accountId, t: Date.now() };
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(data), c.env.SESSION_SECRET, {
    path: "/",
    httpOnly: true,
    secure: c.env.PUBLIC_URL.startsWith("https://"),
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** The account id a valid, unexpired session cookie names, or "". */
export async function sessionAccountId(c: Context<AppEnv>): Promise<string> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!raw) return "";
  try {
    const data = JSON.parse(raw) as SessionData;
    if (typeof data.a !== "string" || typeof data.t !== "number") return "";
    if (Date.now() - data.t > SESSION_DAYS * 86400 * 1000) return "";
    return data.a;
  } catch {
    return "";
  }
}

/** Sets c.var.account from the session cookie; never refuses on its own. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("account") === undefined) c.set("account", null);
  if (c.get("device") === undefined) c.set("device", null);
  const id = await sessionAccountId(c);
  if (id) {
    const account = await accountById(c.env.DB, id);
    if (account) {
      c.set("account", account);
      c.set("authKind", "session");
    }
  }
  await next();
};

/**
 * For browser form posts: the request must come from our own origin.
 *
 * This says where a browser thinks it is, and nothing about who is asking. A
 * script sets Origin to whatever it likes, so this is a second lock on a door
 * that browserOnly() has to be the first lock on.
 */
export function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header("Origin") ?? "";
  if (origin) return origin === c.env.PUBLIC_URL;
  const referer = c.req.header("Referer") ?? "";
  return referer.startsWith(c.env.PUBLIC_URL + "/");
}

/**
 * Refuses a panel's device token on a route only a person should reach.
 *
 * Administering the account is not something a panel does on its owner's
 * behalf: connecting another Mac, removing one, disconnecting Drive, minting
 * a panel sign-in code. A device token is a credential that lives on a laptop
 * for months, and a copy of one used to be enough to enroll a replacement Mac
 * and remove the real one, which is the opposite of what revoking it should
 * do. Returns the refusal, or null to carry on.
 */
export function browserOnly(c: Context<AppEnv>): Response | null {
  if (c.get("authKind") !== "device") return null;
  return c.json(
    { error: "browser_session_required", detail: "Sign in at " + c.env.PUBLIC_URL + " to do this." },
    403,
  );
}
