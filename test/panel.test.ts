import { describe, expect, it } from "vitest";
import { normalizePublicUrl, redirectAllowed } from "../src/panel";
import { claimDevice, get, postJson, signedInAs } from "./helpers";

const PANEL = "https://syllabus.example.com";
const CALLBACK = PANEL + "/account/callback";

async function claimedPanel(email = "me@example.com") {
  const mine = await claimDevice(email, "My Mac");
  const res = await postJson("/device/public-url", { public_url: PANEL }, { Authorization: "Bearer " + mine.token });
  expect(res.status).toBe(200);
  return mine;
}

function authorize(deviceId: string, cookie: string, redirectUri = CALLBACK, state = "st1") {
  const q = new URLSearchParams({ device: deviceId, redirect_uri: redirectUri, state });
  return get("/panel/authorize?" + q, { Cookie: cookie });
}

describe("addresses", () => {
  it("keeps only an https origin as a panel's public address", () => {
    expect(normalizePublicUrl("https://syllabus.example.com")).toBe(PANEL);
    expect(normalizePublicUrl(" https://syllabus.example.com/ ")).toBe(PANEL);
    expect(normalizePublicUrl("http://syllabus.example.com")).toBe("");
    expect(normalizePublicUrl("https://syllabus.example.com/setup")).toBe("");
    expect(normalizePublicUrl("https://u:p@syllabus.example.com")).toBe("");
    expect(normalizePublicUrl("nonsense")).toBe("");
  });
  it("only sends a browser back to a path on the registered address", () => {
    expect(redirectAllowed(PANEL, CALLBACK)).toBe(true);
    expect(redirectAllowed(PANEL, "https://evil.example.com/account/callback")).toBe(false);
    expect(redirectAllowed(PANEL, PANEL + "/account/callback?x=1")).toBe(false);
    expect(redirectAllowed(PANEL, PANEL + "/")).toBe(false);
    expect(redirectAllowed("", CALLBACK)).toBe(false);
  });
});

describe("signing in to a panel through the account", () => {
  it("a panel registers its address; a bad one is refused", async () => {
    const mine = await claimDevice("me@example.com");
    const bad = await postJson("/device/public-url", { public_url: "http://nope" }, { Authorization: "Bearer " + mine.token });
    expect(bad.status).toBe(400);
    const nobody = await postJson("/device/public-url", { public_url: PANEL });
    expect(nobody.status).toBe(401);
    const ok = await postJson("/device/public-url", { public_url: PANEL + "/" }, { Authorization: "Bearer " + mine.token });
    expect(((await ok.json()) as { public_url: string }).public_url).toBe(PANEL);
    expect(await (await get("/", { Cookie: mine.cookie })).text()).toContain("syllabus.example.com");
  });

  it("sends a signed-out person to the login and back to the same link", async () => {
    const mine = await claimedPanel();
    const res = await authorize(mine.deviceId, "");
    expect(res.status).toBe(302);
    const next = new URL("https://x" + decodeURIComponent(res.headers.get("Location")!.split("next=")[1]));
    expect(next.pathname).toBe("/panel/authorize");
    expect(next.searchParams.get("device")).toBe(mine.deviceId);
    expect(next.searchParams.get("redirect_uri")).toBe(CALLBACK);
  });

  it("the owner gets a code back at the panel, and the panel redeems it once", async () => {
    const mine = await claimedPanel();
    const res = await authorize(mine.deviceId, mine.cookie);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("st1");
    const code = back.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    const swap = await postJson("/panel/exchange", { code }, { Authorization: "Bearer " + mine.token });
    expect(swap.status).toBe(200);
    const body = (await swap.json()) as { account: { email: string; id: string } };
    expect(body.account.email).toBe("me@example.com");
    expect(body.account.id).toBe(mine.account.id);

    const again = await postJson("/panel/exchange", { code }, { Authorization: "Bearer " + mine.token });
    expect(again.status).toBe(400);
  });

  it("a code is useless to another device and to no device", async () => {
    const mine = await claimedPanel("me@example.com");
    const other = await claimDevice("them@example.com", "Their Mac");
    const back = new URL((await authorize(mine.deviceId, mine.cookie)).headers.get("Location")!);
    const code = back.searchParams.get("code")!;
    expect((await postJson("/panel/exchange", { code }, { Authorization: "Bearer " + other.token })).status).toBe(400);
    expect((await postJson("/panel/exchange", { code })).status).toBe(401);
    expect((await postJson("/panel/exchange", { code: "made-up" }, { Authorization: "Bearer " + mine.token })).status).toBe(400);
    // The real owner can still redeem it after those attempts.
    expect((await postJson("/panel/exchange", { code }, { Authorization: "Bearer " + mine.token })).status).toBe(200);
  });

  it("someone else's account is told the panel is not theirs", async () => {
    const mine = await claimedPanel("me@example.com");
    const them = await signedInAs("them@example.com");
    const res = await authorize(mine.deviceId, them.cookie);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("belongs to someone else");
    expect(html).toContain("them@example.com");
  });

  it("refuses an unregistered or foreign redirect, an unknown device, and a revoked one", async () => {
    const unregistered = await claimDevice("me@example.com");
    expect((await authorize(unregistered.deviceId, unregistered.cookie)).status).toBe(400);
    const mine = await claimedPanel("me@example.com");
    expect((await authorize(mine.deviceId, mine.cookie, "https://evil.example.com/account/callback")).status).toBe(400);
    expect((await authorize("no-such-device", mine.cookie)).status).toBe(404);
    expect((await authorize(mine.deviceId, mine.cookie, CALLBACK, "")).status).toBe(400);
    await postJson("/device/revoke", {}, { Authorization: "Bearer " + mine.token });
    // Revoking the token does not revoke the device; removing the Mac does.
    expect((await authorize(mine.deviceId, mine.cookie)).status).toBe(302);
  });
});
