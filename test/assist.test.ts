import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { GLOBAL_CEILING, TRIAL_ALLOWANCE } from "../src/proxy";
import { claimDevice, get, ORIGIN } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGES = "https://api.anthropic.com/v1/messages";

type Sent = { url: string; body: Record<string, any> };

/** Anthropic, scripted, with every request body kept for inspection. */
function upstream(answer: (sent: Sent, n: number) => Response) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init.body ?? "{}"));
      sent.push({ url, body });
      return answer(sent[sent.length - 1], sent.length);
    }),
  );
  return sent;
}

function usage(over: Record<string, number> = {}) {
  return { input_tokens: 40, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...over };
}

function replies(text: string, over: Record<string, unknown> = {}) {
  return () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }], usage: usage(), stop_reason: "end_turn", ...over }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function opensCourse(course: string) {
  return () =>
    new Response(
      JSON.stringify({
        content: [
          { type: "thinking", thinking: "" },
          { type: "tool_use", name: "open_course", input: { course } },
        ],
        usage: usage({ output_tokens: 60 }),
        stop_reason: "tool_use",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Enough words that the material is plausibly a lecture rather than a label. */
function lecture(course: string, date: string, title: string, words = 200) {
  return { course, date, title, text: `${title}. ` + `the instructor explained the point again. `.repeat(words / 6) };
}

const SUMMARIES = [
  lecture("ACCT-4321", "2026-09-15", "Process-Costing"),
  lecture("ACCT-4321", "2026-09-17", "Process-Costing-And-CVP"),
  lecture("ENTR-3306", "2026-09-15", "AI-Knowledge-And-Ethics"),
  lecture("RELI-3304", "2026-09-18", "Theories-Of-Biblical-Inspiration"),
];

function ask(body: Record<string, unknown>, token: string) {
  return SELF.fetch(ORIGIN + "/proxy/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      session: "s1",
      scope: "summaries",
      mode: "ask",
      documents: SUMMARIES,
      ...body,
    }),
  });
}

function question(text: string) {
  return [{ role: "user", content: text }];
}

describe("answering from the summaries", () => {
  it("sends the frozen prompt, the sorted material, and nothing a caller chose", async () => {
    const sent = upstream(replies("Process costing averages costs across units."));
    const { token } = await claimDevice("ask@example.com");

    const res = await ask({ messages: question("What is process costing?") }, token);
    expect(res.status).toBe(200);
    const answered = (await res.json()) as Record<string, any>;
    expect(answered.reply).toContain("Process costing");
    expect(answered.escalate).toBeNull();

    expect(sent).toHaveLength(1);
    const body = sent[0].body;
    expect(sent[0].url).toBe(MESSAGES);
    expect(body.model).toBe("claude-sonnet-5");
    // Sonnet 5 takes adaptive or nothing, and a budget_tokens is a 400.
    expect(body.thinking).toEqual({ type: "adaptive" });
    // Effort is the lever on output spend, and study Q&A is not hard reasoning.
    expect(body.output_config.effort).toBe("medium");
    expect(body.system).toContain("study assistant inside Syllabus");
    // One tool, listing the courses actually sent, so a call is answerable.
    expect(body.tools.map((t: any) => t.name)).toEqual(["open_course"]);
    expect(body.tools[0].input_schema.properties.course.enum).toEqual([
      "ACCT-4321",
      "ENTR-3306",
      "RELI-3304",
    ]);
  });

  it("puts the material behind a 5-minute breakpoint and the question in front of nothing", async () => {
    const sent = upstream(replies("Yes."));
    const { token } = await claimDevice("cache-shape@example.com");
    await ask({ messages: question("Was that on the exam?") }, token);

    const first = sent[0].body.messages[0];
    expect(first.role).toBe("user");
    // Block one is every document, cached. Block two is the question, not.
    expect(first.content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(first.content[0].text).toContain("ACCT-4321");
    expect(first.content[1].text).toBe("Was that on the exam?");
    // The default TTL is the cheap one: a read refreshes it and a session is
    // continuous, so an hour would double the write premium to buy nothing.
    const ttls = JSON.stringify(sent[0].body).match(/"ttl"/g);
    expect(ttls).toBeNull();

    // The material is sorted here rather than trusted from the caller, so a
    // panel listing its files in another order still reads the same cache.
    const shuffled = [...SUMMARIES].reverse();
    await ask({ session: "s2", documents: shuffled, messages: question("Was that on the exam?") }, token);
    expect(sent[1].body.messages[0].content[0].text).toBe(sent[0].body.messages[0].content[0].text);
  });

  it("keeps the prefix byte-identical across the turns of one session", async () => {
    // The standing check that caching is working. If this drifts, every
    // follow-up in a session pays for the whole course again.
    const sent = upstream((_s, n) =>
      n === 1
        ? replies("First.")()
        : new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Second." }],
              usage: usage({ input_tokens: 20, cache_read_input_tokens: 4000 }),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
    );
    const { token } = await claimDevice("warm@example.com");

    await ask({ messages: question("What is process costing?") }, token);
    const second = await ask(
      {
        messages: [
          { role: "user", content: "What is process costing?" },
          { role: "assistant", content: "First." },
          { role: "user", content: "And equivalent units?" },
        ],
      },
      token,
    );

    const one = sent[0].body;
    const two = sent[1].body;
    expect(two.system).toBe(one.system);
    expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));
    // Every byte turn one sent is still there, in the same order, with turn
    // two's question added on the end. Nothing was appended to turn one's own
    // message and then taken away again, which is the failure this guards:
    // it would move the prefix and re-charge the whole course every turn.
    const text = (body: any) =>
      body.messages.map((m: any) =>
        Array.isArray(m.content) ? m.content.map((b: any) => b.text).join("\u0000") : m.content);
    expect(text(two).slice(0, 1)).toEqual(text(one));
    // Only the breakpoint moves, on to the end of what has been said since.
    expect(two.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(two.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });

    // And the panel is told what the cache actually did.
    const body = (await second.json()) as Record<string, any>;
    expect(body.usage.cache_read).toBe(4000);
  });

  it("meters money rather than tokens, so a cached read is not charged as a fresh one", async () => {
    upstream(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Answered." }],
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 10_000,
              output_tokens: 800,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const { account, token } = await claimDevice("units@example.com");
    const res = await ask({ messages: question("Why?") }, token);
    expect(res.status).toBe(200);

    // 100 + 1000*1.25 + 10000*0.1 + 800*5 = 6350 input-token equivalents,
    // which is $0.0127 at Sonnet's $2 per M. Counting the 10k cached tokens
    // at face value would have charged nearly twice that for the same call.
    expect(((await res.json()) as { units: number }).units).toBe(6350);
    expect(await db.usedThisPeriod(env.DB, account.id, "assist")).toBe(6350);
  });
});

describe("the second stage", () => {
  it("answers nothing and names the course when the summaries are not enough", async () => {
    const sent = upstream(opensCourse("ACCT-4321"));
    const { account, token } = await claimDevice("escalate@example.com");

    const res = await ask({ messages: question("Walk me through the overhead example she did.") }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.escalate).toEqual({ course: "ACCT-4321" });
    expect(body.reply).toBe("");
    expect(sent).toHaveLength(1);

    // The escalation is recorded the moment it happens, because the tier
    // table moves with the share of sessions that need a whole course.
    expect(await db.assistSessionsThisPeriod(env.DB, account.id)).toEqual({ started: 1, escalated: 1 });

    // The panel comes back with that one course, and this leg is offered no
    // tool: there is nothing further to open.
    upstream(replies("She started with $40,000 of overhead."));
    const full = await SELF.fetch(ORIGIN + "/proxy/assist", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(token) },
      body: JSON.stringify({
        session: "s1",
        scope: "course",
        course: "ACCT-4321",
        mode: "ask",
        documents: SUMMARIES.filter((d) => d.course === "ACCT-4321"),
        messages: question("Walk me through the overhead example she did."),
      }),
    });
    expect(full.status).toBe(200);
    expect(((await full.json()) as { reply: string }).reply).toContain("$40,000");
  });

  it("will not open a course the panel never sent", async () => {
    upstream(opensCourse("PHYS-1101"));
    const { token } = await claimDevice("phantom@example.com");
    const res = await ask({ messages: question("What about physics?") }, token);
    const body = (await res.json()) as Record<string, any>;
    expect(body.escalate.course).toBe("ACCT-4321");
  });

  it("escalates a study guide without paying a call to be told so", async () => {
    const sent = upstream(replies("never reached"));
    const { account, token } = await claimDevice("guide@example.com");

    const res = await ask({ mode: "study_guide", course: "RELI-3304", messages: question("Study guide please") }, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).escalate).toEqual({ course: "RELI-3304" });
    expect(sent).toHaveLength(0);
    expect(await db.usedThisPeriod(env.DB, account.id, "assist")).toBe(0);
    expect(await db.assistSessionsThisPeriod(env.DB, account.id)).toEqual({ started: 1, escalated: 1 });
  });

  it("carries the mode on every student turn and the date with the material", async () => {
    const sent = upstream(replies("Question one."));
    const { token } = await claimDevice("quiz@example.com");
    await ask(
      {
        mode: "quiz",
        messages: [
          { role: "user", content: "Quiz me" },
          { role: "assistant", content: "What is process costing?" },
          { role: "user", content: "Averaging" },
        ],
      },
      token,
    );

    const messages = sent[0].body.messages;
    // On the student's turns, both of them, and not on the assistant's.
    expect(messages[0].content[1].text).toContain("Quiz the student");
    expect(messages[2].content[0].text).toContain("Quiz the student");
    expect(JSON.stringify(messages[1])).not.toContain("Quiz the student");

    // The date sits with the material, which is stable for a session, rather
    // than on the latest turn, which is not.
    expect(messages[0].content[0].text).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
    // And neither is in the system prompt, where they would sit ahead of the
    // material and re-charge the whole course on every mode switch.
    expect(sent[0].body.system).not.toContain("Today is");
    expect(sent[0].body.system).not.toContain("Quiz the student");
  });
});

describe("what a stolen device token can buy", () => {
  it("stops a new session at the cap but lets an open one finish", async () => {
    upstream(replies("Answered."));
    const { account, token } = await claimDevice("capped@example.com");
    await db.putAllowance(env.DB, account.id, 3600, 1000, "test", 5_000_000, 2);

    expect((await ask({ session: "a", messages: question("one") }, token)).status).toBe(200);
    expect((await ask({ session: "b", messages: question("two") }, token)).status).toBe(200);

    const third = await ask({ session: "c", messages: question("three") }, token);
    expect(third.status).toBe(402);
    const body = (await third.json()) as Record<string, any>;
    expect(body.error).toBe("session_cap_reached");
    expect(body.started).toBe(2);

    // The conversation already in progress is not cut off by the cap: it
    // costs the same money and refusing it is only rude.
    expect((await ask({ session: "a", messages: question("one more") }, token)).status).toBe(200);
  });

  it("refuses when the units are gone, and gives them back when the provider fails", async () => {
    const { account, token } = await claimDevice("broke@example.com");
    // Room for one question and its reservation, and not for a second: the
    // reservation holds the worst case, so what is left is what is left even
    // though the first call settled for a fraction of what it held.
    await db.putAllowance(env.DB, account.id, 3600, 1000, "test", 25_000, 50);

    upstream(() => new Response("upstream is down", { status: 503 }));
    const failed = await ask({ messages: question("one") }, token);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("provider_unavailable");
    // Nothing was spent, so the retry has the whole allowance again.
    expect(await db.usedThisPeriod(env.DB, account.id, "assist")).toBe(0);

    upstream(replies("Answered."));
    expect((await ask({ messages: question("one") }, token)).status).toBe(200);

    // A second question no longer fits: the reservation holds the worst case.
    const refused = await ask({ session: "again", messages: question("two") }, token);
    expect(refused.status).toBe(402);
    const body = (await refused.json()) as Record<string, any>;
    expect(body.error).toBe("allowance_exhausted");
    expect(body.unit).toBe("assist_units");
  });

  it("refuses everyone once the service as a whole has spent its month", async () => {
    const sent = upstream(replies("never reached"));
    const hog = await claimDevice("assist-hog@example.com");
    await env.DB.prepare(
      "INSERT INTO usage (id, account_id, device_id, kind, units, period, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'final')",
    )
      .bind("assist-ceiling", hog.account.id, hog.deviceId, "assist", GLOBAL_CEILING.assist_units, db.usagePeriod(), new Date().toISOString())
      .run();

    const other = await claimDevice("assist-innocent@example.com");
    const res = await ask({ messages: question("anything") }, other.token);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("service_ceiling");
    expect(sent).toHaveLength(0);
  });

  it("rate limits the endpoint the way the other two are limited", async () => {
    upstream(replies("Answered."));
    const { token } = await claimDevice("flood@example.com");
    let last = 200;
    for (let i = 0; i < 17; i++) {
      last = (await ask({ session: `s${i}`, messages: question("go") }, token)).status;
    }
    expect(last).toBe(429);
  });
});

describe("what a caller may not say", () => {
  it("turns away a browser session and an anonymous request", async () => {
    const sent = upstream(replies("never reached"));
    const { cookie } = await claimDevice("assist-browser@example.com");
    const asSession = await SELF.fetch(ORIGIN + "/proxy/assist", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ session: "s1", scope: "summaries", documents: SUMMARIES, messages: question("hi") }),
    });
    expect(asSession.status).toBe(401);
    expect(((await asSession.json()) as { error: string }).error).toBe("not_a_device");
    expect(sent).toHaveLength(0);
  });

  it("refuses a full-course request carrying more than one course", async () => {
    const sent = upstream(replies("never reached"));
    const { token } = await claimDevice("two-courses@example.com");
    const res = await ask({ scope: "course", course: "ACCT-4321", messages: question("hi") }, token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("exactly one course");
    expect(sent).toHaveLength(0);
  });

  it("refuses a malformed session, mode, scope or conversation", async () => {
    const sent = upstream(replies("never reached"));
    const { token } = await claimDevice("malformed@example.com");
    const cases: [Record<string, unknown>, string][] = [
      [{ session: "../../etc", messages: question("hi") }, "session must be"],
      [{ scope: "everything", messages: question("hi") }, "scope must be"],
      [{ mode: "roast", messages: question("hi") }, "mode must be"],
      [{ documents: [], messages: question("hi") }, "documents is required"],
      [{ messages: [] }, "messages is required"],
      [{ messages: [{ role: "assistant", content: "hello" }] }, "the first message"],
      [
        { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "there" }] },
        "the last message",
      ],
      [{ messages: [{ role: "user", content: "x".repeat(9000) }] }, "may not exceed"],
    ];
    for (const [body, detail] of cases) {
      const res = await ask(body, token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toContain(detail);
    }
    expect(sent).toHaveLength(0);
  });
});

describe("what is left", () => {
  it("reports both assistant meters and how many sessions escalated", async () => {
    const { account, token, deviceId } = await claimDevice("assist-usage@example.com");
    const fresh = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(fresh.assist_units.allowance).toBe(TRIAL_ALLOWANCE.assist_units);
    expect(fresh.assist_sessions).toEqual({
      used: 0,
      allowance: TRIAL_ALLOWANCE.assist_sessions,
      left: TRIAL_ALLOWANCE.assist_sessions,
      escalated: 0,
    });

    await db.recordUsage(env.DB, account.id, deviceId, "assist", 65_000, "anthropic");
    await db.openAssistSession(env.DB, account.id, "s1", deviceId, 10);
    await db.markAssistEscalated(env.DB, account.id, "s1", "ACCT-4321");
    await db.openAssistSession(env.DB, account.id, "s2", deviceId, 10);

    const spent = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(spent.assist_units.used).toBe(65_000);
    expect(spent.assist_units.left).toBe(TRIAL_ALLOWANCE.assist_units - 65_000);
    expect(spent.assist_sessions.used).toBe(2);
    expect(spent.assist_sessions.escalated).toBe(1);
  });

  it("keeps an allowance written before the assistant existed on the trial for it", async () => {
    const { account, token } = await claimDevice("older-row@example.com");
    // The shape of every row slice 4 wrote before this migration: real audio
    // and summary figures, nothing at all for the assistant.
    await db.putAllowance(env.DB, account.id, 45 * 3600, 900_000, "pro");
    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.source).toBe("pro");
    expect(usage.audio_seconds.allowance).toBe(45 * 3600);
    expect(usage.assist_units.allowance).toBe(TRIAL_ALLOWANCE.assist_units);
    expect(usage.assist_sessions.allowance).toBe(TRIAL_ALLOWANCE.assist_sessions);
  });
});
