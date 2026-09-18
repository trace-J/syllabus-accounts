import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ReqFrame, ResFrame, ChunkFrame, WelcomeFrame } from "../src/panel-relay";
import { panelUrl, relayAllowed } from "../src/relay";
import { fromBase64, toBase64 } from "../src/util";
import { claimDevice, get, ORIGIN, postJson, signedInAs } from "./helpers";

const text = (s: string) => toBase64(new TextEncoder().encode(s));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** Open the panel's socket the way intake/relay.py does, and script its answers. */
async function connectPanel(token: string, answer: (req: ReqFrame) => Array<ResFrame | ChunkFrame> | null) {
  const res = await SELF.fetch(ORIGIN + "/relay/connect", {
    headers: { Upgrade: "websocket", Authorization: "Bearer " + token },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const seen: ReqFrame[] = [];
  const welcome = new Promise<WelcomeFrame>((resolve) => {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ReqFrame | WelcomeFrame;
      if (frame.t === "welcome") return resolve(frame);
      if (frame.t !== "req") return;
      seen.push(frame);
      const replies = answer(frame);
      if (replies) for (const reply of replies) ws.send(JSON.stringify(reply));
    });
  });
  // Closing is not finished when close() returns: the socket belongs to the
  // Durable Object, and workerd is not idle until the object has observed it
  // going. A test that ends while the server side is still open leaves the
  // pool waiting on a child that never exits, which is a hang with every
  // test passing. Always close through this.
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
  const close = async (code?: number, reason?: string) => {
    ws.close(code, reason);
    await closed;
  };
  return { ws, seen, welcome: await welcome, close };
}

const echo = (req: ReqFrame): ResFrame[] => [
  {
    t: "res",
    id: req.id,
    status: 200,
    headers: { "Content-Type": "application/json", "X-Secret": "never" },
    body: text(JSON.stringify({ path: req.path, query: req.query, method: req.method, viewer: req.viewer, base: req.base, body: req.body ? utf8(fromBase64(req.body)) : "", headers: req.headers })),
  },
];

describe("what may be relayed", () => {
  it("is the panel's pages, its API, and its images, by GET or POST", () => {
    expect(relayAllowed("GET", "/")).toBe(true);
    expect(relayAllowed("GET", "/setup")).toBe(true);
    expect(relayAllowed("GET", "/api/status")).toBe(true);
    expect(relayAllowed("POST", "/api/record/start")).toBe(true);
    expect(relayAllowed("GET", "/static/icon.png")).toBe(true);
    expect(relayAllowed("DELETE", "/api/status")).toBe(false);
    expect(relayAllowed("GET", "/login")).toBe(false);
    expect(relayAllowed("GET", "/logout")).toBe(false);
    expect(relayAllowed("GET", "/static/../.env")).toBe(false);
    expect(relayAllowed("GET", "/inbox/lecture.m4a")).toBe(false);
    expect(relayAllowed("GET", "/api/status/../../x")).toBe(false);
  });
  it("names a device's address", () => {
    expect(panelUrl("https://accounts.test/", "d1")).toBe("https://accounts.test/p/d1/");
  });
});

describe("the panel's socket", () => {
  it("needs the device bearer and an upgrade", async () => {
    expect((await get("/relay/connect", { Upgrade: "websocket" })).status).toBe(401);
    const mine = await claimDevice("me@example.com");
    expect((await get("/relay/connect", { Authorization: "Bearer " + mine.token })).status).toBe(426);
  });

  it("welcomes the panel with the limits it should honor", async () => {
    const mine = await claimDevice("me@example.com");
    const { welcome, close } = await connectPanel(mine.token, () => null);
    expect(welcome.device).toBe(mine.deviceId);
    expect(welcome.chunk_bytes).toBeGreaterThan(0);
    expect(welcome.max_response_bytes).toBeGreaterThan(welcome.chunk_bytes);
    await close();
  });
});

describe("a browser at /p/<device>/", () => {
  it("is sent to the login when signed out, and back to the same page", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await get(`/p/${mine.deviceId}/setup?x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?next=" + encodeURIComponent(`/p/${mine.deviceId}/setup?x=1`));
    expect((await get(`/p/${mine.deviceId}/api/status`)).status).toBe(401);
  });

  it("adds the trailing slash", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await get(`/p/${mine.deviceId}`, { Cookie: mine.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/p/${mine.deviceId}/`);
  });

  it("refuses anyone but the owner, and an unknown or removed device", async () => {
    const mine = await claimDevice("me@example.com");
    const other = await signedInAs("other@example.com");
    const res = await get(`/p/${mine.deviceId}/`, { Cookie: other.cookie });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("belongs to someone else");
    expect((await get(`/p/${mine.deviceId}/api/status`, { Cookie: other.cookie })).status).toBe(403);
    expect((await get(`/p/nosuchdevice/`, { Cookie: mine.cookie })).status).toBe(404);
    await SELF.fetch(ORIGIN + `/devices/${mine.deviceId}/revoke`, { method: "POST", headers: { Cookie: mine.cookie, Origin: ORIGIN }, redirect: "manual" });
    expect((await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie })).status).toBe(404);
  });

  it("carries nothing the panel does not serve", async () => {
    const mine = await claimDevice("me@example.com");
    expect((await get(`/p/${mine.deviceId}/logout`, { Cookie: mine.cookie })).status).toBe(404);
    expect((await get(`/p/${mine.deviceId}/api/../.env`, { Cookie: mine.cookie })).status).toBe(404);
    const del = await SELF.fetch(ORIGIN + `/p/${mine.deviceId}/api/status`, { method: "DELETE", headers: { Cookie: mine.cookie, Origin: ORIGIN } });
    expect(del.status).toBe(404);
  });

  it("says the Mac is not connected instead of timing out", async () => {
    const mine = await claimDevice("me@example.com", "Kitchen iMac");
    const pageRes = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    expect(pageRes.status).toBe(503);
    expect(pageRes.headers.get("Retry-After")).toBe("10");
    const html = await pageRes.text();
    expect(html).toContain("is not connected");
    expect(html).toContain("has not connected from that Mac yet");
    const apiRes = await get(`/p/${mine.deviceId}/api/status`, { Cookie: mine.cookie });
    expect(apiRes.status).toBe(503);
    expect(((await apiRes.json()) as { relay: string }).relay).toBe("not-connected");
  });

  it("relays a request to the connected panel and its answer back, with the viewer named", async () => {
    const mine = await claimDevice("me@example.com", "My Mac");
    const { seen, close } = await connectPanel(mine.token, echo);
    const res = await get(`/p/${mine.deviceId}/api/status?since=1`, { Cookie: mine.cookie, Accept: "application/json", "X-Forwarded-For": "1.2.3.4" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Secret")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.path).toBe("/api/status");
    expect(body.query).toBe("since=1");
    expect(body.method).toBe("GET");
    expect(body.viewer).toEqual({ email: "me@example.com", account_id: mine.account.id });
    expect(body.base).toBe(`/p/${mine.deviceId}`);
    expect(body.headers).toEqual({ accept: "application/json" });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.cookie).toBeUndefined();
    await close();
  });

  it("relays a POST body from the owner, and refuses one from another site", async () => {
    const mine = await claimDevice("me@example.com");
    const { close } = await connectPanel(mine.token, echo);
    const res = await postJson(`/p/${mine.deviceId}/api/record/start`, { course: "ACCT-4321" }, { Cookie: mine.cookie, Origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: string }).body).toBe(JSON.stringify({ course: "ACCT-4321" }));
    const cross = await postJson(`/p/${mine.deviceId}/api/record/start`, {}, { Cookie: mine.cookie, Origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const big = await postJson(`/p/${mine.deviceId}/api/setup`, { pad: "x".repeat(70 * 1024) }, { Cookie: mine.cookie, Origin: ORIGIN });
    expect(big.status).toBe(413);
    await close();
  });

  it("reassembles a chunked answer", async () => {
    const mine = await claimDevice("me@example.com");
    const { close } = await connectPanel(mine.token, (req) => [
      { t: "res", id: req.id, status: 200, headers: { "Content-Type": "text/html" }, body: text("<html>part one, "), more: true },
      { t: "chunk", id: req.id, body: text("part two, "), more: true },
      { t: "chunk", id: req.id, body: text("done</html>") },
    ]);
    const res = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>part one, part two, done</html>");
    await close();
  });

  it("passes a 304 for an image through with no body", async () => {
    const mine = await claimDevice("me@example.com");
    const { close } = await connectPanel(mine.token, (req) => [{ t: "res", id: req.id, status: 304, headers: { ETag: '"abc"' } }]);
    const res = await get(`/p/${mine.deviceId}/static/icon.png`, { Cookie: mine.cookie, "If-None-Match": '"abc"' });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"abc"');
    await close();
  });

  it("is not connected again once the panel's socket closes, remembering when", async () => {
    const mine = await claimDevice("me@example.com", "My Mac");
    const { close } = await connectPanel(mine.token, echo);
    expect((await get(`/p/${mine.deviceId}/api/status`, { Cookie: mine.cookie })).status).toBe(200);
    await close(1000, "panel stopping");
    let res = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    for (let i = 0; i < 20 && res.status !== 503; i++) {
      await new Promise((r) => setTimeout(r, 25));
      res = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    }
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("My Mac is not connected");
    expect(html).toContain("Last connected");
  });

  it("the account page lists each Mac's address and whether it is connected", async () => {
    const mine = await claimDevice("me@example.com", "Kitchen iMac");
    let html = await (await get("/", { Cookie: mine.cookie })).text();
    expect(html).toContain(`/p/${mine.deviceId}/`);
    expect(html).toContain("has not connected yet");
    const { close } = await connectPanel(mine.token, echo);
    html = await (await get("/", { Cookie: mine.cookie })).text();
    expect(html).toContain("Connected now");
    await close(1000, "bye");
    for (let i = 0; i < 20 && html.includes("Connected now"); i++) {
      await new Promise((r) => setTimeout(r, 25));
      html = await (await get("/", { Cookie: mine.cookie })).text();
    }
    expect(html).toContain("Not connected, last connected");
  });

  it("the newest panel connection wins", async () => {
    const mine = await claimDevice("me@example.com");
    const first = await connectPanel(mine.token, () => null);
    const second = await connectPanel(mine.token, (req) => [{ t: "res", id: req.id, status: 200, headers: {}, body: text("second") }]);
    const res = await get(`/p/${mine.deviceId}/api/status`, { Cookie: mine.cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("second");
    expect(first.seen).toHaveLength(0);
    // Both, not just the newest: the replaced socket is still workerd's to close.
    await Promise.all([first.close(), second.close()]);
  });
});
