/**
 * Settings documents: small named texts that belong to an account and a
 * profile, so a Mac's settings can follow the person to another Mac.
 *
 *   GET /settings/:name              the document, or 404
 *   PUT /settings/:name {content, expected_updated_at?}
 *
 * Both take the device bearer; the profile is the device's. The first
 * document is "schedule", the text of the panel's schedule file. A PUT
 * with expected_updated_at is refused with 409, and the current document,
 * when someone else wrote in between: the panel then decides which copy
 * wins rather than this service.
 */

import { Hono } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";

export const MAX_CONTENT = 64 * 1024;
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const settings = new Hono<AppEnv>();

function shape(row: db.Setting) {
  return { name: row.name, profile: row.profile, content: row.content, updated_at: row.updated_at, updated_by: row.updated_by };
}

settings.get("/settings/:name", async (c) => {
  const device = c.get("device");
  const account = c.get("account");
  if (!device || !account) return c.json({ error: "not_a_device" }, 401);
  const name = c.req.param("name");
  if (!NAME.test(name)) return c.json({ error: "invalid_request" }, 400);
  const row = await db.getSetting(c.env.DB, account.id, device.profile, name);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(shape(row));
});

settings.put("/settings/:name", async (c) => {
  const device = c.get("device");
  const account = c.get("account");
  if (!device || !account) return c.json({ error: "not_a_device" }, 401);
  const name = c.req.param("name");
  if (!NAME.test(name)) return c.json({ error: "invalid_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as { content?: unknown; expected_updated_at?: unknown } | null;
  if (!body || typeof body.content !== "string") return c.json({ error: "invalid_request", detail: "content must be a string" }, 400);
  if (body.content.length > MAX_CONTENT) return c.json({ error: "too_large", limit: MAX_CONTENT }, 413);
  const expected = typeof body.expected_updated_at === "string" ? body.expected_updated_at : null;
  const row = await db.putSetting(c.env.DB, account.id, device.profile, name, body.content, device.id, expected);
  if (!row) {
    const current = await db.getSetting(c.env.DB, account.id, device.profile, name);
    return c.json({ error: "conflict", current: current ? shape(current) : null }, 409);
  }
  return c.json(shape(row));
});
