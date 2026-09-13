import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { claimDevice, get, ORIGIN } from "./helpers";

function put(name: string, body: unknown, token?: string) {
  return SELF.fetch(`${ORIGIN}/settings/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  });
}

describe("settings documents", () => {
  // Rows persist across the tests in this file, so each uses its own account.
  it("needs a device, a sane name, and a string", async () => {
    expect((await get("/settings/schedule")).status).toBe(401);
    const mine = await claimDevice("a@example.com");
    expect((await put("schedule", { content: "x" })).status).toBe(401);
    expect((await get("/settings/Bad Name", { Authorization: "Bearer " + mine.token })).status).toBe(400);
    expect((await put("schedule", { content: 5 }, mine.token)).status).toBe(400);
    expect((await put("schedule", { content: "x".repeat(70000) }, mine.token)).status).toBe(413);
  });

  it("is empty until written, then reads back with a version", async () => {
    const mine = await claimDevice("b@example.com");
    expect((await get("/settings/schedule", { Authorization: "Bearer " + mine.token })).status).toBe(404);
    const wrote = await put("schedule", { content: "classes = []\n" }, mine.token);
    expect(wrote.status).toBe(200);
    const body = (await wrote.json()) as { content: string; updated_at: string; updated_by: string; profile: string };
    expect(body.content).toBe("classes = []\n");
    expect(body.updated_by).toBe(mine.deviceId);
    expect(body.profile).toBe("syllabus");
    const read = (await (await get("/settings/schedule", { Authorization: "Bearer " + mine.token })).json()) as typeof body;
    expect(read).toEqual(body);
  });

  it("refuses a write built on a stale version and returns the current one", async () => {
    const mine = await claimDevice("c@example.com");
    const other = await claimDevice("c@example.com", "Other Mac");
    const v1 = (await (await put("schedule", { content: "one", expected_updated_at: "" }, mine.token)).json()) as { updated_at: string };
    const v2 = (await (await put("schedule", { content: "two", expected_updated_at: v1.updated_at }, other.token)).json()) as { updated_at: string };
    expect(v2.updated_at > v1.updated_at).toBe(true);
    const stale = await put("schedule", { content: "three", expected_updated_at: v1.updated_at }, mine.token);
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { error: string; current: { content: string; updated_at: string } };
    expect(conflict.current.content).toBe("two");
    expect(conflict.current.updated_at).toBe(v2.updated_at);
    // Without an expectation, the write is last-writer-wins.
    expect((await put("schedule", { content: "three" }, mine.token)).status).toBe(200);
    // An expectation of "" means "nothing stored yet", which is no longer true.
    expect((await put("schedule", { content: "four", expected_updated_at: "" }, mine.token)).status).toBe(409);
  });

  it("keeps documents apart by account", async () => {
    const mine = await claimDevice("d@example.com");
    const theirs = await claimDevice("e@example.com");
    await put("schedule", { content: "mine" }, mine.token);
    expect((await get("/settings/schedule", { Authorization: "Bearer " + theirs.token })).status).toBe(404);
    await put("schedule", { content: "theirs" }, theirs.token);
    const back = (await (await get("/settings/schedule", { Authorization: "Bearer " + mine.token })).json()) as { content: string };
    expect(back.content).toBe("mine");
  });
});
