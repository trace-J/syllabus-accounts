import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "../src/crypto";
import { toBase64Url } from "../src/util";
import { claimDevice, get, postForm, postJson, signedInAs } from "./helpers";

const CLIENT = "test-client-id.apps.googleusercontent.com";
const DRIVE = "https://www.googleapis.com/auth/drive.file";

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

/** Google's token and revoke endpoints, scripted. Records what was sent. */
function google(answer: (url: string, sent: URLSearchParams) => { status: number; body: unknown }) {
  const calls: { url: string; sent: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const sent = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ url, sent });
      const out = answer(url, sent);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

async function connect(email: string) {
  const { account, cookie } = await signedInAs(email);
  const start = await get("/drive/connect", { Cookie: cookie });
  const to = new URL(start.headers.get("Location")!);
  const flowCookie = start.headers.get("Set-Cookie")!.split(";")[0];
  const nonce = to.searchParams.get("nonce")!;
  const state = to.searchParams.get("state")!;
  return { account, cookie, to, flowCookie, nonce, state };
}

function grantBody(nonce: string, over: Record<string, unknown> = {}) {
  return {
    access_token: "ya29.first",
    refresh_token: "1//refresh-secret",
    scope: `openid email ${DRIVE}`,
    id_token: jwt({
      iss: "https://accounts.google.com", aud: CLIENT, sub: "g1", exp: Math.floor(Date.now() / 1000) + 300,
      nonce, email: "Me@Gmail.com", email_verified: true,
    }),
    ...over,
  };
}

describe("the box", () => {
  it("round-trips and refuses the wrong key", async () => {
    const sealed = await encrypt("k1", "1//refresh");
    expect(sealed).not.toContain("refresh");
    expect(await decrypt("k1", sealed)).toBe("1//refresh");
    await expect(decrypt("k2", sealed)).rejects.toThrow();
  });
});

describe("connecting Drive to the account", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks Google for drive.file with offline access, and for consent", async () => {
    const { to } = await connect("a@example.com");
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("scope")).toBe(`openid email ${DRIVE}`);
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(to.searchParams.get("prompt")).toBe("consent");
    expect(to.searchParams.get("login_hint")).toBe("a@example.com");
    expect(to.searchParams.get("redirect_uri")).toBe("https://accounts.test/oauth2/callback");
    expect((await get("/drive/connect")).headers.get("Location")).toContain("/login?next=");
  });

  it("stores the refresh token encrypted and shows the connection", async () => {
    const { account, cookie, flowCookie, nonce, state } = await connect("b@example.com");
    const calls = google((_u, sent) => ({ status: 200, body: grantBody(nonce) }));
    const cb = await get(`/oauth2/callback?state=${state}&code=drive-code`, { Cookie: `${cookie}; ${flowCookie}` });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/");
    expect(calls[0].sent.get("code")).toBe("drive-code");
    expect(calls[0].sent.get("grant_type")).toBe("authorization_code");

    const row = await env.DB.prepare("SELECT * FROM drive_grants WHERE account_id = ?").bind(account.id).first<Record<string, string>>();
    expect(row).not.toBeNull();
    expect(row!.refresh_token_enc).not.toContain("refresh-secret");
    expect(await decrypt(env.DRIVE_KEY, row!.refresh_token_enc)).toBe("1//refresh-secret");
    expect(row!.google_email).toBe("me@gmail.com");

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Connected");
    expect(html).toContain("me@gmail.com");
    const status = (await (await get("/drive/status", { Cookie: cookie })).json()) as { connected: boolean };
    expect(status.connected).toBe(true);
  });

  it("refuses a grant without Drive, without a refresh token, or with a bad nonce", async () => {
    let { flowCookie, nonce, state, cookie } = await connect("c@example.com");
    google(() => ({ status: 200, body: grantBody(nonce, { scope: "openid email" }) }));
    let cb = await get(`/oauth2/callback?state=${state}&code=x`, { Cookie: `${cookie}; ${flowCookie}` });
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain("was not granted");

    ({ flowCookie, nonce, state, cookie } = await connect("c@example.com"));
    google(() => ({ status: 200, body: grantBody(nonce, { refresh_token: undefined }) }));
    cb = await get(`/oauth2/callback?state=${state}&code=x`, { Cookie: `${cookie}; ${flowCookie}` });
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain("lasting grant");

    ({ flowCookie, state, cookie } = await connect("c@example.com"));
    google(() => ({ status: 200, body: grantBody("other-nonce") }));
    cb = await get(`/oauth2/callback?state=${state}&code=x`, { Cookie: `${cookie}; ${flowCookie}` });
    expect(cb.status).toBe(502);
    expect((await (await get("/drive/status", { Cookie: cookie })).json() as { connected: boolean }).connected).toBe(false);
  });
});

describe("a panel asking for a Drive token", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connected(email: string) {
    const { cookie, flowCookie, nonce, state } = await connect(email);
    google(() => ({ status: 200, body: grantBody(nonce) }));
    await get(`/oauth2/callback?state=${state}&code=x`, { Cookie: `${cookie}; ${flowCookie}` });
    vi.unstubAllGlobals();
    return claimDevice(email);
  }

  it("gets a one-hour access token minted from the stored refresh token", async () => {
    const mine = await connected("d@example.com");
    const calls = google(() => ({ status: 200, body: { access_token: "ya29.fresh", expires_in: 3599, scope: DRIVE } }));
    const res = await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBe("ya29.fresh");
    expect(body.expires_in).toBe(3599);
    expect(body.google_email).toBe("me@gmail.com");
    expect(calls[0].sent.get("grant_type")).toBe("refresh_token");
    expect(calls[0].sent.get("refresh_token")).toBe("1//refresh-secret");
    expect(calls[0].sent.get("client_secret")).toBe("test-client-secret");
  });

  it("says so when there is no grant, and needs a device", async () => {
    const mine = await claimDevice("e@example.com");
    const res = await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_grant");
    expect((await postJson("/drive/token", {})).status).toBe(401);
  });

  it("marks the grant revoked when Google stops honoring it", async () => {
    const mine = await connected("f@example.com");
    google(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const res = await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("grant_revoked");
    vi.unstubAllGlobals();
    const status = (await (await get("/drive/status", { Authorization: "Bearer " + mine.token })).json()) as { connected: boolean; revoked_reason: string };
    expect(status.connected).toBe(false);
    expect(status.revoked_reason).toContain("no longer honors");
    const html = await (await get("/", { Cookie: mine.cookie })).text();
    expect(html).toContain("stopped working");
  });

  it("passes on a Google outage without touching the grant", async () => {
    const mine = await connected("g@example.com");
    google(() => ({ status: 503, body: { error: "backend" } }));
    expect((await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token })).status).toBe(502);
    vi.unstubAllGlobals();
    expect(((await (await get("/drive/status", { Authorization: "Bearer " + mine.token })).json()) as { connected: boolean }).connected).toBe(true);
  });

  it("disconnecting revokes at Google and forgets the grant", async () => {
    const mine = await connected("h@example.com");
    const calls = google(() => ({ status: 200, body: {} }));
    const res = await postForm("/drive/disconnect", {}, { Cookie: mine.cookie });
    expect(res.status).toBe(302);
    expect(calls[0].url).toContain("https://oauth2.googleapis.com/revoke?token=1%2F%2Frefresh-secret");
    vi.unstubAllGlobals();
    expect((await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token })).status).toBe(404);
    expect((await postForm("/drive/disconnect", {}, { Cookie: mine.cookie, Origin: "https://evil.test" })).status).toBe(403);
  });
});
