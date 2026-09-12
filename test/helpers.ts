import { env, SELF } from "cloudflare:test";
import { serializeSigned } from "hono/utils/cookie";
import { upsertAccount } from "../src/db";
import { SESSION_COOKIE } from "../src/session";

export const ORIGIN = "https://accounts.test";

/** An account in the test database, plus a Cookie header that is its session. */
export async function signedInAs(email: string, sub = "sub-" + email) {
  const account = await upsertAccount(env.DB, { sub, email, name: "Test Person", picture: "" });
  const cookie = await serializeSigned(
    SESSION_COOKIE,
    JSON.stringify({ a: account.id, t: Date.now() }),
    env.SESSION_SECRET,
    { path: "/" },
  );
  return { account, cookie: cookie.split(";")[0] };
}

export function get(path: string, headers: Record<string, string> = {}) {
  return SELF.fetch(ORIGIN + path, { headers, redirect: "manual" });
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

export function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return SELF.fetch(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** Walk the whole device flow: start, approve as `email`, poll. Returns the token. */
export async function claimDevice(email: string, name = "Test Mac") {
  const started = (await (await postJson("/device/start", { name, profile: "syllabus" })).json()) as {
    device_code: string;
    user_code: string;
  };
  const { account, cookie } = await signedInAs(email);
  const approved = await postForm("/device/approve", { user_code: started.user_code }, { Cookie: cookie });
  if (approved.status !== 200) throw new Error(`approve answered ${approved.status}: ${await approved.text()}`);
  const polled = (await (await postJson("/device/poll", { device_code: started.device_code })).json()) as {
    token: string;
    device: { id: string };
  };
  return { account, cookie, token: polled.token, deviceId: polled.device.id, userCode: started.user_code };
}
