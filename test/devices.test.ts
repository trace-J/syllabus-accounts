import { describe, expect, it } from "vitest";
import { claimDevice, get, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

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

/**
 * SEC-03 from the September 16 audit. A device token used to be interchangeable
 * with its owner's browser session, because both put an account into the same
 * place on the request. A copy of one taken off a laptop could connect another
 * Mac, remove the Mac it was taken from, and outlive being revoked.
 */
describe("a device token is not a person", () => {
  it("cannot approve another Mac, with or without a plausible Origin", async () => {
    const { token } = await claimDevice("me@example.com", "My Mac");
    const started = (await (await postJson("/device/start", { name: "Not Mine" })).json()) as {
      device_code: string;
      user_code: string;
    };

    const headerSets: Record<string, string>[] = [
      { Authorization: "Bearer " + token },
      { Authorization: "Bearer " + token, Referer: ORIGIN + "/device" },
    ];
    for (const headers of headerSets) {
      const res = await postForm("/device/approve", { user_code: started.user_code }, headers);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("browser_session_required");
    }

    // And no token was left waiting to be collected.
    const polled = await postJson("/device/poll", { device_code: started.device_code });
    expect(((await polled.json()) as { error: string }).error).toBe("authorization_pending");
  });

  it("cannot remove another Mac on the same account", async () => {
    const first = await claimDevice("me@example.com", "First Mac");
    const other = (await (await postJson("/device/start", { name: "Second Mac" })).json()) as {
      device_code: string;
      user_code: string;
    };
    await postForm("/device/approve", { user_code: other.user_code }, { Cookie: first.cookie });
    const otherDevice = (await (await postJson("/device/poll", { device_code: other.device_code })).json()) as {
      token: string;
      device: { id: string };
    };

    const res = await postForm(`/devices/${otherDevice.device.id}/revoke`, {}, { Authorization: "Bearer " + first.token });
    expect(res.status).toBe(403);
    expect((await get("/me", { Authorization: "Bearer " + otherDevice.token })).status).toBe(200);
  });

  it("cannot do a browser's business with its own token", async () => {
    const { token } = await claimDevice("me@example.com");
    expect((await postForm("/drive/disconnect", {}, { Authorization: "Bearer " + token })).status).toBe(403);
    expect((await get("/drive/connect", { Authorization: "Bearer " + token })).status).toBe(403);
  });

  it("still does everything a panel is supposed to do", async () => {
    const { token } = await claimDevice("me@example.com");
    expect((await get("/me", { Authorization: "Bearer " + token })).status).toBe(200);
    expect((await get("/drive/status", { Authorization: "Bearer " + token })).status).toBe(200);
    // Signing itself out is its own business, and still works.
    expect((await postJson("/device/revoke", {}, { Authorization: "Bearer " + token })).status).toBe(200);
  });
});

describe("signing out every Mac", () => {
  it("takes the replacements with it and leaves other accounts alone", async () => {
    const mine = await claimDevice("me@example.com", "My Mac");
    const second = (await (await postJson("/device/start", { name: "Spare" })).json()) as {
      device_code: string;
      user_code: string;
    };
    await postForm("/device/approve", { user_code: second.user_code }, { Cookie: mine.cookie });
    const spare = (await (await postJson("/device/poll", { device_code: second.device_code })).json()) as { token: string };
    const theirs = await claimDevice("them@example.com", "Their Mac");

    const res = await postForm("/devices/revoke-all", {}, { Cookie: mine.cookie });
    expect(res.status).toBe(302);
    expect((await get("/me", { Authorization: "Bearer " + mine.token })).status).toBe(401);
    expect((await get("/me", { Authorization: "Bearer " + spare.token })).status).toBe(401);
    expect((await get("/me", { Authorization: "Bearer " + theirs.token })).status).toBe(200);

    // A fresh claim afterwards works, on the account's new version.
    const again = await claimDevice("me@example.com", "Replacement");
    expect((await get("/me", { Authorization: "Bearer " + again.token })).status).toBe(200);
  });

  it("is not something a device token can do, and needs our own origin", async () => {
    const { token, cookie } = await claimDevice("me@example.com");
    expect((await postForm("/devices/revoke-all", {}, { Authorization: "Bearer " + token })).status).toBe(403);
    expect((await postForm("/devices/revoke-all", {}, { Cookie: cookie, Origin: "https://evil.test" })).status).toBe(403);
    expect((await get("/me", { Authorization: "Bearer " + token })).status).toBe(200);
  });
});

/**
 * SEC-07 from the September 16 audit. /device/start answers before anybody
 * has proved who they are, and it writes a row and burns a user code every
 * time. Thirty-one consecutive anonymous requests were accepted, each one
 * allocating a new pending claim.
 */
describe("the open device routes have a limit", () => {
  const from = (ip: string) => ({ "CF-Connecting-IP": ip });

  it("stops one source from allocating claims without end", async () => {
    const codes = new Set<string>();
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      const res = await postJson("/device/start", { name: "Flood" }, from("198.51.100.7"));
      if (res.status === 429) {
        refused += 1;
        expect(res.headers.get("Retry-After")).toBeTruthy();
      } else {
        expect(res.status).toBe(200);
        codes.add(((await res.json()) as { user_code: string }).user_code);
      }
    }
    expect(codes.size).toBeLessThanOrEqual(10);
    expect(refused).toBeGreaterThan(0);

    // A different Mac somewhere else is unaffected by that one's behavior.
    const elsewhere = await postJson("/device/start", { name: "Innocent" }, from("198.51.100.8"));
    expect(elsewhere.status).toBe(200);
  });

  it("limits polling too, and a panel's own pace is nowhere near it", async () => {
    const started = (await (await postJson("/device/start", {}, from("198.51.100.9"))).json()) as {
      device_code: string;
    };
    // A real panel polls every 5 seconds: twelve times in the window below.
    for (let i = 0; i < 12; i++) {
      const res = await postJson("/device/poll", { device_code: started.device_code }, from("198.51.100.9"));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("authorization_pending");
    }
    // Past the limit it answers slow_down, which the panel's claim loop waits
    // on rather than treating as a refusal: a claim in progress survives.
    let sawSlowDown = false;
    for (let i = 0; i < 60 && !sawSlowDown; i++) {
      const res = await postJson("/device/poll", { device_code: started.device_code }, from("198.51.100.9"));
      sawSlowDown = ((await res.json()) as { error: string }).error === "slow_down";
    }
    expect(sawSlowDown).toBe(true);
  });

  it("still lets a person claim a Mac normally", async () => {
    const { token } = await claimDevice("normal@example.com", "An Ordinary Mac");
    expect((await get("/me", { Authorization: "Bearer " + token })).status).toBe(200);
  });
});
