import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClaims, decodeClaims, safeNext, type IdClaims } from "../src/google";
import { toBase64Url } from "../src/util";
import { get, signedInAs } from "./helpers";

const CLIENT = "test-client-id.apps.googleusercontent.com";

function jwt(claims: Partial<IdClaims>): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256", kid: "x" })}.${enc(claims)}.sig`;
}

function freshClaims(over: Partial<IdClaims> = {}): IdClaims {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "1234567890",
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "n1",
    email: "Me@Example.com",
    email_verified: true,
    name: "Me",
    ...over,
  };
}

describe("checking Google's ID token", () => {
  it("accepts a fresh token for our client with the right nonce", () => {
    expect(() => checkClaims(freshClaims(), CLIENT, "n1")).not.toThrow();
    expect(() => checkClaims(freshClaims({ iss: "accounts.google.com" }), CLIENT, "n1")).not.toThrow();
  });
  it("refuses the wrong issuer, audience, nonce, an expired token, and an unverified email", () => {
    expect(() => checkClaims(freshClaims({ iss: "https://evil.test" }), CLIENT, "n1")).toThrow(/issuer/);
    expect(() => checkClaims(freshClaims({ aud: "other" }), CLIENT, "n1")).toThrow(/another client/);
    expect(() => checkClaims(freshClaims(), CLIENT, "n2")).toThrow(/nonce/);
    expect(() => checkClaims(freshClaims({ exp: 1 }), CLIENT, "n1")).toThrow(/expired/);
    expect(() => checkClaims(freshClaims({ email_verified: false }), CLIENT, "n1")).toThrow(/verified/);
  });
  it("decodes the payload of a JWT", () => {
    expect(decodeClaims(jwt(freshClaims())).email).toBe("Me@Example.com");
    expect(() => decodeClaims("not.a.jwt.at.all")).toThrow();
  });
  it("only returns to a path on this site", () => {
    expect(safeNext("/device?code=X")).toBe("/device?code=X");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

/** Stand in for Google's token endpoint. The Worker runs in this isolate, so
 *  stubbing the global fetch reaches its outbound call and nothing else. */
function googleAnswers(status: number, body: unknown) {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://oauth2.googleapis.com/token") throw new Error("unexpected fetch to " + url);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("the sign-in routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the browser to Google with a state cookie", async () => {
    const res = await get("/login?next=/device");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("client_id")).toBe(CLIENT);
    expect(to.searchParams.get("redirect_uri")).toBe("https://accounts.test/oauth2/callback");
    expect(to.searchParams.get("scope")).toBe("openid email profile");
    expect(res.headers.get("Set-Cookie")).toContain("syllabus_accounts_signin=");
  });

  it("refuses a callback that did not start here", async () => {
    const res = await get("/oauth2/callback?state=abc&code=xyz");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not start here");
  });

  it("signs in a person whose code Google accepts, then shows their account", async () => {
    const login = await get("/login?next=/");
    const flowCookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const to = new URL(login.headers.get("Location")!);
    const state = to.searchParams.get("state")!;
    const nonce = to.searchParams.get("nonce")!;

    const google = googleAnswers(200, { id_token: jwt(freshClaims({ nonce })) });

    const cb = await get(`/oauth2/callback?state=${state}&code=good`, { Cookie: flowCookie });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/");
    expect(google).toHaveBeenCalledOnce();
    const sent = new URLSearchParams(String((google.mock.calls[0][1] as RequestInit).body));
    expect(sent.get("code")).toBe("good");
    expect(sent.get("client_secret")).toBe("test-client-secret");
    expect(sent.get("redirect_uri")).toBe("https://accounts.test/oauth2/callback");
    const session = cb.headers.get("Set-Cookie")!.split(",").find((c: string) => c.includes("syllabus_accounts_session="))!;
    const html = await (await get("/", { Cookie: session.split(";")[0] })).text();
    expect(html).toContain("me@example.com");
  });

  it("reports a token endpoint failure without signing anyone in", async () => {
    const login = await get("/login");
    const flowCookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
    googleAnswers(400, { error: "invalid_grant" });
    const cb = await get(`/oauth2/callback?state=${state}&code=bad`, { Cookie: flowCookie });
    expect(cb.status).toBe(502);
    expect(cb.headers.get("Set-Cookie") ?? "").not.toContain("syllabus_accounts_session=");
  });

  it("shows the landing page to nobody and the account page to someone", async () => {
    expect(await (await get("/")).text()).toContain("Sign in with Google");
    const { cookie } = await signedInAs("me@example.com");
    expect(await (await get("/", { Cookie: cookie })).text()).toContain("Your Macs");
    const me = await get("/me", { Cookie: cookie });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { device: unknown }).device).toBeNull();
  });

  it("signs out", async () => {
    const { cookie } = await signedInAs("me@example.com");
    const res = await get("/logout", { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("syllabus_accounts_session=;");
  });
});
