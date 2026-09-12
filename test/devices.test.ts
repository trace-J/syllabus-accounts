import { describe, expect, it } from "vitest";
import { claimDevice, get, postForm, postJson, signedInAs } from "./helpers";

describe("claiming a panel", () => {
  it("hands out a code a person can type", async () => {
    const res = await postJson("/device/start", { name: "Trace's MacBook Pro" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verification_uri).toBe("https://accounts.test/device");
    expect(String(body.verification_uri_complete)).toContain("code=" + body.user_code);
    expect(body.interval).toBe(5);
  });

  it("is pending until a person approves it", async () => {
    const started = (await (await postJson("/device/start", {})).json()) as { device_code: string };
    const res = await postJson("/device/poll", { device_code: started.device_code });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("authorization_pending");
  });

  it("sends a signed-out person to the login, keeping the code", async () => {
    const res = await get("/device?code=ABCD-EFGH");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?next=" + encodeURIComponent("/device?code=ABCD-EFGH"));
  });

  it("shows the Mac's name to the person approving it", async () => {
    const started = (await (await postJson("/device/start", { name: "Kitchen iMac" })).json()) as { user_code: string };
    const { cookie } = await signedInAs("me@example.com");
    const html = await (await get("/device?code=" + started.user_code, { Cookie: cookie })).text();
    expect(html).toContain("Kitchen iMac");
    expect(html).toContain("me@example.com");
  });

  it("approves, then the poll returns a token that works as a bearer", async () => {
    const { token, account } = await claimDevice("me@example.com", "Kitchen iMac");
    expect(token).toMatch(/^syd_/);
    const me = await get("/me", { Authorization: "Bearer " + token });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { account: { email: string; id: string }; device: { name: string } };
    expect(body.account.email).toBe("me@example.com");
    expect(body.account.id).toBe(account.id);
    expect(body.device.name).toBe("Kitchen iMac");
  });

  it("hands the token out once", async () => {
    const started = (await (await postJson("/device/start", {})).json()) as { device_code: string; user_code: string };
    const { cookie } = await signedInAs("me@example.com");
    await postForm("/device/approve", { user_code: started.user_code }, { Cookie: cookie });
    const first = await postJson("/device/poll", { device_code: started.device_code });
    expect(first.status).toBe(200);
    const second = await postJson("/device/poll", { device_code: started.device_code });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("accepts the code however it was typed", async () => {
    const started = (await (await postJson("/device/start", {})).json()) as { device_code: string; user_code: string };
    const { cookie } = await signedInAs("me@example.com");
    const sloppy = started.user_code.toLowerCase().replace("-", " ");
    const res = await postForm("/device/approve", { user_code: sloppy }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("now belongs to me@example.com");
  });

  it("refuses a code that was already used, an unknown code, and a bad shape", async () => {
    const { cookie, userCode } = await claimDevice("me@example.com");
    const again = await postForm("/device/approve", { user_code: userCode }, { Cookie: cookie });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("already used");
    const unknown = await postForm("/device/approve", { user_code: "ZZZZ-9999" }, { Cookie: cookie });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("not waiting");
    const short = await postForm("/device/approve", { user_code: "ABC" }, { Cookie: cookie });
    expect(short.status).toBe(400);
  });

  it("refuses an approval posted from another origin", async () => {
    const started = (await (await postJson("/device/start", {})).json()) as { user_code: string };
    const { cookie } = await signedInAs("me@example.com");
    const res = await postForm("/device/approve", { user_code: started.user_code }, { Cookie: cookie, Origin: "https://evil.test" });
    expect(res.status).toBe(403);
  });

  it("rejects a made-up or revoked bearer", async () => {
    expect((await get("/me", { Authorization: "Bearer syd_nope" })).status).toBe(401);
    const { token } = await claimDevice("me@example.com");
    const out = await postJson("/device/revoke", {}, { Authorization: "Bearer " + token });
    expect(out.status).toBe(200);
    expect((await get("/me", { Authorization: "Bearer " + token })).status).toBe(401);
  });

  it("lets the owner remove a Mac from the account page, and nobody else", async () => {
    const mine = await claimDevice("me@example.com", "My Mac");
    const theirs = await signedInAs("them@example.com");
    const denied = await postForm(`/devices/${mine.deviceId}/revoke`, {}, { Cookie: theirs.cookie });
    expect(denied.status).toBe(302);
    expect((await get("/me", { Authorization: "Bearer " + mine.token })).status).toBe(200);
    const page = await (await get("/", { Cookie: mine.cookie })).text();
    expect(page).toContain("My Mac");
    const removed = await postForm(`/devices/${mine.deviceId}/revoke`, {}, { Cookie: mine.cookie });
    expect(removed.status).toBe(302);
    expect((await get("/me", { Authorization: "Bearer " + mine.token })).status).toBe(401);
    expect(await (await get("/", { Cookie: mine.cookie })).text()).not.toContain("My Mac");
  });
});
