/**
 * A panel on the web, for every Mac on an account, at one address each:
 *
 *   https://syllabusaccounts.maincoursemedia.com/p/<device>/
 *
 * Nothing to install or configure on the Mac beyond Syllabus itself. The
 * panel keeps a WebSocket open to this service, and the browser's requests
 * travel down it (panel-relay.ts). This module is the HTTP face of that:
 *
 *   GET  /relay/connect        the panel, with its device bearer, upgrades
 *                              to a WebSocket held by its device's object
 *   ANY  /p/:device/*          a browser; the person signed in must own the
 *                              device, and the request must be one the panel
 *                              serves (its pages, its API, its two images)
 *
 * Who the viewer is travels with each relayed request, so the panel never
 * runs a sign-in of its own for these; the account session here is the
 * sign-in. The panel trusts the identity because it arrived on the socket
 * the panel itself opened with its device token.
 */

import { Hono } from "hono";
import * as db from "./db";
import type { AppEnv, Bindings } from "./env";
import { notYoursPage, page } from "./pages";
import { MAX_BODY_BYTES, REQUEST_HEADERS, type RelayState } from "./panel-relay";
import { sameOrigin } from "./session";
import { PANEL_PREFIX } from "./util";

export { PANEL_PREFIX, panelUrl } from "./util";

const METHODS = new Set(["GET", "POST"]);
// What the panel serves and a browser may ask for. Nothing else exists on
// the panel, and nothing else will be carried: not a recording, not a log.
const PATHS = [/^\/$/, /^\/setup$/, /^\/api\/[a-z0-9_\-/]*$/i, /^\/static\/[a-z0-9_\-.]+$/i];

/** Whether the panel serves such a request at all. */
export function relayAllowed(method: string, path: string): boolean {
  return METHODS.has(method) && PATHS.some((re) => re.test(path)) && !path.includes("..");
}

/** Ask a device's object whether its panel is connected right now. */
export async function relayState(env: Bindings, deviceId: string): Promise<RelayState & { connected: boolean }> {
  const stub = env.PANEL.get(env.PANEL.idFromName(deviceId));
  const res = await stub.fetch("https://panel-relay/", { headers: { "X-Relay-Op": "state" } });
  return (await res.json()) as RelayState & { connected: boolean };
}

export const relay = new Hono<AppEnv>();

relay.get("/relay/connect", async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 401);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected_websocket" }, 426);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Authorization");
  headers.set("X-Relay-Op", "connect");
  headers.set("X-Relay-Device", device.id);
  headers.set("X-Relay-Device-Name", device.name);
  const stub = c.env.PANEL.get(c.env.PANEL.idFromName(device.id));
  return stub.fetch("https://panel-relay/", { method: "GET", headers });
});

relay.all("/p/:device", (c) => c.redirect(c.req.path + "/" + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "")));

relay.all("/p/:device/*", async (c) => {
  const deviceId = c.req.param("device");
  const url = new URL(c.req.url);
  const base = PANEL_PREFIX + deviceId;
  const rest = url.pathname.slice(base.length) || "/";
  const isApi = rest.startsWith("/api/");
  const isPage = c.req.method === "GET" && !isApi && !rest.startsWith("/static/");

  const account = c.get("account");
  if (!account || c.get("device")) {
    if (isPage) return c.redirect("/login?next=" + encodeURIComponent(url.pathname + url.search));
    return c.json({ error: "not_signed_in" }, 401);
  }
  if (!relayAllowed(c.req.method, rest)) {
    if (isApi) return c.json({ error: "not_found" }, 404);
    return c.html(page("Not found", "<p>The panel has no such page.</p>"), 404);
  }
  if (c.req.method !== "GET" && !sameOrigin(c)) return c.json({ error: "cross_origin" }, 403);

  const device = await db.deviceById(c.env.DB, deviceId);
  if (!device) {
    if (isApi) return c.json({ error: "unknown_device" }, 404);
    return c.html(
      page("Sign in", "<p>That Syllabus is not connected to any account. Its owner can connect it from its Setup page.</p>"),
      404,
    );
  }
  if (device.account_id !== account.id) {
    console.log(`refused ${account.email} at the panel of device ${device.id}: belongs to another account`);
    if (isApi) return c.json({ error: "not_yours" }, 403);
    return c.html(notYoursPage(account.email), 403);
  }

  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return c.json({ error: "too_large" }, 413);
  const body = c.req.method === "GET" ? undefined : await c.req.arrayBuffer();
  if (body && body.byteLength > MAX_BODY_BYTES) return c.json({ error: "too_large" }, 413);

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Relay-Viewer-Email", account.email);
  headers.set("X-Relay-Viewer-Account", account.id);
  headers.set("X-Relay-Base", base);
  headers.set("X-Relay-Device-Name", device.name);
  const stub = c.env.PANEL.get(c.env.PANEL.idFromName(device.id));
  return stub.fetch("https://panel-relay" + rest + url.search, { method: c.req.method, headers, body });
});
