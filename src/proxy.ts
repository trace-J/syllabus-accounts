/**
 * The managed-key proxy: the two paid calls, made from here instead of a Mac.
 *
 *   POST /proxy/transcribe   (device bearer) one audio chunk -> transcript text
 *   POST /proxy/summarize    (device bearer) a transcript -> the summary object
 *   POST /proxy/assist       (device bearer) a study question -> an answer
 *   GET  /proxy/usage        (device bearer or session) what is left this month
 *
 * Why this exists: until now every user pasted their own OpenAI and Anthropic
 * keys into ~/.intake/syllabus/.env. Here the keys are Worker secrets, so
 * signing in is the whole of setup. That also makes this service a spender of
 * real money on a caller's say-so, which is what the rest of this file is
 * about.
 *
 * It is deliberately NOT an API gateway. The model, the upstream URL, the
 * request shape, the system prompt and the response schema are all fixed
 * here; the profile on the caller's own device row picks between the two
 * prompt sets (prompts.ts) and nothing else about the upstream call is
 * reachable from a request body. A caller sends audio, or a transcript and
 * the two labels that frame it, or a study question and the lecture material
 * to answer it from, and that is all.
 *
 * Three things bound the damage from a stolen device token, which used to
 * read somebody's own data and now spends money:
 *
*   1. A monthly allowance per account, RESERVED before the upstream call and
 *      settled to what it actually cost afterwards. Reserving rather than
 *      checking is what makes two simultaneous calls see each other; a check
 *      followed by a write lets both through. Slice 4 (Stripe) writes real
 *      allowances; until then every account gets TRIAL_ALLOWANCE below.
 *   2. A per-minute rate limit per account on both endpoints, so a token that
 *      leaks cannot burn a month's allowance in a minute.
 *   3. Hard caps on request size and on transcript length, refused before
 *      anything is read or forwarded.
 *   4. A ceiling across every account together (GLOBAL_CEILING), so a bad
 *      afternoon has a worst case that does not depend on how many accounts
 *      exist or on anything a caller says.
 *
 * Upstream errors are never passed through. A 401 from OpenAI means our key,
 * not the caller's, so the caller is told the provider refused and nothing
 * else; the status is logged and the body is dropped. No key appears in a
 * response, a log line, or an error, here or anywhere.
 *
 * No audio and no transcript is stored. Both stream through to the provider
 * and what persists is a usage row with a number in it.
 */

import { Hono, type Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { mp4DurationSeconds } from "./mp4";
import {
  ASSIST_MODES,
  type AssistMode,
  assistSystem,
  OPEN_COURSE_TOOL,
  openCourseTool,
  profileSpec,
  type StudyDocument,
  studyContext,
  userMessage,
} from "./prompts";

// --- What is fixed here, and not by a caller --------------------------------

/**
 * Transcription runs on Groq when there is a key for it, and on OpenAI when
 * there is not or when Groq will not answer.
 *
 * Why two: transcription is the whole of the audio cost (about $0.18 of the
 * $0.21 an hour of lecture costs on OpenAI), and Groq serves the same job at
 * $0.111 an hour for whisper-large-v3. That is the single biggest line on the
 * bill and the cheapest one to move, because nothing about the request shape
 * changes: Groq speaks the OpenAI transcription API.
 *
 * Why OpenAI stays: this service spends ONE key for every account, so a
 * provider rate limit is a ceiling on the whole product rather than on one
 * user. Groq's free tier allows 7,200 audio seconds an hour across everyone,
 * which 25 students can exhaust between them. Falling back means a Groq limit
 * costs money instead of costing transcriptions.
 *
 * The fallback is deliberately taken on ANY Groq failure, not just 429. A
 * wrong or expired Groq key should make lectures expensive, never broken. The
 * status is logged every time so "expensive" does not go unnoticed.
 *
 * Turbo (whisper-large-v3-turbo) is $0.04 an hour, 2.8x cheaper again, at 12%
 * WER against large-v3's 10.3% on Groq's own figures. It is one constant away
 * and it is not taken yet: the provider benchmark on a real lecture is what
 * decides whether that accuracy is affordable, not this file.
 */
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_TRANSCRIBE_MODEL = "whisper-large-v3";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SUMMARY_MODEL = "claude-sonnet-5";
const SUMMARY_MAX_TOKENS = 16000;
const SUMMARY_TOOL = "record_summary";

/**
 * The study assistant runs on Claude Sonnet 5, and the choice is the whole of
 * the Pro price.
 *
 * Modeled at 15 sessions a month, the assistant costs $9.90 on Opus 5 and
 * $3.96 on Sonnet 5 ($5/$25 per M against $2/$10). That $5.94 is what makes
 * Pro at $22 net $10.31 instead of $4.37, so the model is not a performance
 * knob here, it is the price of the tier. It was taken on an eval over real
 * course material rather than on the arithmetic alone (evals/assistant in
 * this repo); if a later eval says Sonnet does not hold, the honest move is
 * to change the price, not to quietly spend Opus money on a $22 plan.
 *
 * Three things Sonnet 5 will not do, all of which shape the code below:
 * there are no mid-conversation system messages, so the system prompt is
 * frozen in prompts.ts; assistant prefill is gone, so the reply is shaped by
 * the prompt; and thinking takes `adaptive` or nothing, never a budget.
 */
const ASSIST_MODEL = "claude-sonnet-5";
/**
 * A follow-up in a study session runs about 800 output tokens and a study
 * guide runs longer. Four thousand leaves room for the long case without
 * inviting an essay, and the call is not streamed, so it also has to finish
 * inside an HTTP request.
 */
const ASSIST_MAX_TOKENS = 4000;
/**
 * Effort is the direct lever on output spend and study Q&A is not hard
 * reasoning, so this sits at the low end of the range rather than the
 * default `high`.
 *
 * It is one fixed value rather than a per-request one on purpose: effort is
 * a top-level field, so changing it mid-conversation invalidates the message
 * cache, and a student who asked two questions and then pressed "Quiz me"
 * would pay for the whole course again. The eval sweeps low against medium;
 * this is where the answer goes.
 */
const ASSIST_EFFORT = "medium";

/**
 * What an assist call costs, in input-token equivalents.
 *
 * Sonnet 5 is $2.00 per M in and $10.00 per M out, a 5-minute cache write is
 * 1.25x the input rate and a read is 0.1x. Metering the raw token count
 * instead would charge a cached read the same as a fresh one and overstate a
 * warm session by nearly ten times, which would refuse Pro accounts doing
 * exactly what Pro is sold for. So one unit is one input token's worth of
 * money, $2 per million of them, and every part of the response's usage is
 * converted into it here.
 *
 * The 5-minute TTL is the default and is deliberate. A study session is
 * continuous, a read refreshes the TTL, and the 1-hour TTL would double the
 * write premium to buy nothing.
 */
const ASSIST_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

// --- Limits -----------------------------------------------------------------

/**
 * The Mac splits audio into 8-minute chunks before upload (CHUNK_SECONDS in
 * intake/config.py), which is about 3.8MB at the mono 64kbps it encodes to.
 * A chunk stream-copied from an already-AAC source keeps the source bitrate,
 * so the cap is set at 8 minutes of 192kbps with room to spare. The proxy
 * never sees a whole lecture, so anything much larger than this is not a
 * chunk and is refused rather than handled.
 */
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_SUMMARIZE_BYTES = 1024 * 1024;
/** About 100k tokens. A 75-minute lecture is nearer 12k words, so this is slack. */
const MAX_TRANSCRIPT_CHARS = 400_000;
/** A chunk is 8 minutes; 30 allows a re-split or a longer chunk rule later. */
const MAX_CHUNK_SECONDS = 1800;
const MAX_LABEL_CHARS = 120;

/**
 * How an audio chunk's seconds are decided, which is the number the whole
 * allowance rests on.
 *
 * The caller does not get to decide it. An .m4a states its own length in its
 * moov/mvhd header (mp4.ts), and that is what is charged. A caller's declared
 * duration is only ever used to charge MORE, never less, so overstating costs
 * the caller and understating buys nothing.
 *
 * A byte count is no substitute for reading the header: seconds per byte
 * depend on the bitrate the caller picked, so the same 12MB is eight minutes
 * at 192kbps and over three hours at 8kbps. Anything whose header cannot be
 * read is therefore charged as though it were the lowest bitrate this service
 * will entertain (32kbps), which makes an unreadable upload the expensive way
 * to send audio rather than the cheap one.
 */
const UNREADABLE_AUDIO_BYTES_PER_SECOND = 4_000;

/** Requests per account per window, per endpoint. */
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMITS = { transcribe: 20, summarize: 5, assist: 15 } as const;

/**
 * An assist request carries the material the answer is drawn from, so it is
 * the largest body this service takes: one course's full transcripts run
 * about 240k tokens, which is near a megabyte of text. Two megabytes is that
 * with room, and anything past it is not a course.
 */
const MAX_ASSIST_BYTES = 2 * 1024 * 1024;
/** About 300k tokens of material, refused before a token of it is paid for. */
const MAX_ASSIST_CONTEXT_CHARS = 1_200_000;
const MAX_ASSIST_DOCUMENTS = 500;
/** A session with more turns than this is not a study session. */
const MAX_ASSIST_MESSAGES = 60;
const MAX_ASSIST_MESSAGE_CHARS = 8_000;
const MAX_SESSION_ID_CHARS = 64;

/**
 * The allowance an account has before slice 4 gives it a real one: the
 * 5-hour trial. Audio is metered in seconds, summaries in tokens (input plus
 * output). 5 hours of lecture needs about 48k summary tokens, so the token
 * figure is headroom for retries rather than a second product limit.
 */
export const TRIAL_ALLOWANCE = {
  audio_seconds: 5 * 3600,
  summary_tokens: 150_000,
  /**
   * Five study sessions, and the units to run them: five summaries-only
   * sessions are about 65k units each and one that opens a whole course is
   * about 524k, so this covers the trial even if one of the five escalates.
   */
  assist_units: 900_000,
  assist_sessions: 5,
};

/**
 * What this whole service may spend in a month, across every account.
 *
 * Per-account allowances answer "what can one caller cost"; this answers
 * "what can the bill be", which is the question a card statement asks. It is
 * set well above any plausible real month and is meant to be hit only when
 * something is wrong: a leak of many tokens at once, a retry storm, a bug
 * here. Raise it deliberately when real accounts approach it.
 */
export const GLOBAL_CEILING = {
  audio_seconds: 400 * 3600,
  summary_tokens: 12_000_000,
  /** 75M units is $150 of assistant in a month, at eighty times one trial. */
  assist_units: 75_000_000,
};

export const proxy = new Hono<AppEnv>();

// --- Small helpers ----------------------------------------------------------

type Refusal = { status: 400 | 401 | 402 | 413 | 429 | 502; body: Record<string, unknown>; headers?: Record<string, string> };

function refuse(c: Context<AppEnv>, r: Refusal) {
  return c.json(r.body, r.status, r.headers ?? {});
}

/**
 * Whatever went wrong upstream, said in our own words.
 *
 * The provider's body is never forwarded and never logged: a 401 is about our
 * key and an error body can quote a request back. The status alone is enough
 * to tell a panel whether to retry, and enough to find the call in the logs.
 */
function providerFailed(what: string, status: number): Refusal {
  console.log(`proxy: ${what} answered ${status}`);
  if (status === 429) return { status: 429, body: { error: "provider_busy" }, headers: { "Retry-After": "30" } };
  return { status: 502, body: { error: "provider_unavailable" } };
}

function overAllowance(kind: db.UsageKind, used: number, wanted: number, allowed: number): Refusal {
  return {
    status: 402,
    body: {
      error: "allowance_exhausted",
      kind,
      unit: kind === "transcribe" ? "audio_seconds" : kind === "assist" ? "assist_units" : "tokens",
      used,
      requested: wanted,
      allowance: allowed,
      period: db.usagePeriod(),
    },
  };
}

function ceilingReached(kind: db.UsageKind): Refusal {
  console.log(`proxy: the ${kind} ceiling for ${db.usagePeriod()} is reached; refusing until it is raised`);
  return {
    status: 402,
    body: { error: "service_ceiling", kind, period: db.usagePeriod() },
  };
}

/** The account's allowance for the month: its own row, or the trial default. */
async function allowanceFor(database: D1Database, accountId: string) {
  const row = await db.allowance(database, accountId);
  return {
    audio_seconds: row?.audio_seconds ?? TRIAL_ALLOWANCE.audio_seconds,
    summary_tokens: row?.summary_tokens ?? TRIAL_ALLOWANCE.summary_tokens,
    // Null, not absent: an allowance row written before the assistant existed
    // carries no assist figures, and that account is on the trial for those
    // two meters while keeping whatever audio and summary figures it was given.
    assist_units: row?.assist_units ?? TRIAL_ALLOWANCE.assist_units,
    assist_sessions: row?.assist_sessions ?? TRIAL_ALLOWANCE.assist_sessions,
    source: row?.source || "trial",
  };
}

function tooLarge(cap: number): Refusal {
  return { status: 413, body: { error: "too_large", limit_bytes: cap } };
}

function declaredLength(header: string | undefined, cap: number): Refusal | null {
  const length = Number(header ?? "");
  if (Number.isFinite(length) && length > cap) return tooLarge(cap);
  return null;
}

/**
 * The request body, refused the moment it passes `cap` actual bytes.
 *
 * Content-Length is a claim, and a chunked request does not even make it. A
 * streamed body with no length header used to go straight into req.json(),
 * which reads until the sender stops: the stated cap was enforced against
 * well-behaved callers only. Here the bytes are counted as they arrive and
 * the read is abandoned as soon as there are too many, so an oversized body
 * is never fully held in memory, let alone parsed or forwarded.
 *
 * Returns the bytes, or the refusal to send back.
 */
async function boundedBody(c: Context<AppEnv>, cap: number): Promise<Uint8Array | Refusal> {
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return tooLarge(cap);
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400, body: { error: "bad_request", detail: "the request body could not be read" } };
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function isRefusal(v: Uint8Array | Refusal): v is Refusal {
  return !(v instanceof Uint8Array);
}

function label(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

// --- The endpoints ----------------------------------------------------------

/**
 * One audio chunk in, its transcript out.
 *
 * multipart/form-data with an `audio` file part and a `duration_seconds`
 * field. Everything about the upstream call other than those bytes is fixed
 * above; in particular no `prompt` is sent, because passing the previous
 * chunk's tail makes these models re-transcribe it (see _transcribe_chunk in
 * intake/transcribe.py).
 */
/**
 * One audio chunk to whichever transcription provider will take it.
 *
 * Groq first when a key exists, OpenAI second. The form is rebuilt for each
 * attempt rather than reused: a FormData that has been sent has had its blob
 * consumed, and a silently empty retry body is worse than a second object.
 *
 * Only these three fields ever reach a provider. Neither the caller's own
 * field names nor a prompt is forwarded, on either leg.
 */
async function transcribeUpstream(
  c: Context<AppEnv>,
  bytes: Uint8Array,
  audio: File,
): Promise<{ ok: true; text: string; provider: string } | { ok: false; what: string; status: number }> {
  const legs = [
    { who: "groq", what: "groq transcription", url: GROQ_TRANSCRIBE_URL, model: GROQ_TRANSCRIBE_MODEL, key: c.env.GROQ_API_KEY },
    { who: "openai", what: "openai transcription", url: OPENAI_TRANSCRIBE_URL, model: OPENAI_TRANSCRIBE_MODEL, key: c.env.OPENAI_API_KEY },
  ];

  let last = { what: "transcription", status: 0 };
  for (const leg of legs) {
    // No key for this leg is not a failure, it is a leg that does not exist.
    // An unset GROQ_API_KEY is how this service runs on OpenAI alone.
    if (!leg.key) continue;

    const upstream = new FormData();
    upstream.set("file", new Blob([bytes], { type: audio.type || "audio/mp4" }), audio.name || "chunk.m4a");
    upstream.set("model", leg.model);
    upstream.set("response_format", "text");

    let res: Response;
    try {
      res = await fetch(leg.url, { method: "POST", headers: { Authorization: `Bearer ${leg.key}` }, body: upstream });
    } catch {
      console.log(`proxy: ${leg.what} could not be reached`);
      last = { what: leg.what, status: 0 };
      continue;
    }
    if (res.ok) return { ok: true, text: await res.text(), provider: leg.who };

    // Logged on every fall-through, because falling through to OpenAI costs
    // real money and a Groq key that has quietly stopped working should show
    // up here rather than on a card statement.
    console.log(`proxy: ${leg.what} answered ${res.status}`);
    last = { what: leg.what, status: res.status };
  }
  return { ok: false, ...last };
}

proxy.post("/proxy/transcribe", async (c) => {
  const account = c.get("account");
  const device = c.get("device");
  if (!account || !device) return c.json({ error: "not_a_device" }, 401);

  const tooLong = declaredLength(c.req.header("Content-Length"), MAX_AUDIO_BYTES);
  if (tooLong) return refuse(c, tooLong);

  const gate = await db.hitRateLimit(c.env.DB, `transcribe:${account.id}`, RATE_LIMITS.transcribe, RATE_WINDOW_SECONDS);
  if (!gate.allowed) {
    return c.json({ error: "rate_limited", limit: RATE_LIMITS.transcribe, window_seconds: RATE_WINDOW_SECONDS }, 429, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  // Read to the cap first: formData() on the raw request would buffer and
  // parse a multipart body of any size before audio.size below could object.
  const body = await boundedBody(c, MAX_AUDIO_BYTES);
  if (isRefusal(body)) return refuse(c, body);
  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "Content-Type": c.req.header("Content-Type") ?? "" },
    }).formData();
  } catch {
    return c.json({ error: "bad_request", detail: "expected multipart/form-data" }, 400);
  }
  const audio = form.get("audio");
  if (!(audio instanceof File)) return c.json({ error: "bad_request", detail: "no audio part" }, 400);
  if (audio.size === 0) return c.json({ error: "bad_request", detail: "audio part is empty" }, 400);
  // The declared length can be absent or a lie; the real size settles it.
  if (audio.size > MAX_AUDIO_BYTES) return c.json({ error: "too_large", limit_bytes: MAX_AUDIO_BYTES }, 413);

  // Still required, though it can now only raise the charge: it is the
  // caller's own account of the chunk, kept so an .m4a whose header lies
  // short is still billed for what the caller knows it sent.
  const raw = form.get("duration_seconds");
  const declared = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_CHUNK_SECONDS) {
    return c.json({ error: "bad_request", detail: `duration_seconds must be 1 to ${MAX_CHUNK_SECONDS}` }, 400);
  }
  // Read once: the same bytes are measured and then forwarded.
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const measured = mp4DurationSeconds(bytes);
  const seconds = measured === null
    ? Math.max(Math.ceil(declared), Math.ceil(bytes.byteLength / UNREADABLE_AUDIO_BYTES_PER_SECOND))
    : Math.max(Math.ceil(measured), Math.ceil(declared));
  if (seconds > MAX_CHUNK_SECONDS) {
    return c.json({ error: "too_long", limit_seconds: MAX_CHUNK_SECONDS, audio_seconds: seconds }, 413);
  }

  const allowed = await allowanceFor(c.env.DB, account.id);
  await db.sweepReservations(c.env.DB, account.id);
  if ((await db.usedGlobally(c.env.DB, "transcribe")) + seconds > GLOBAL_CEILING.audio_seconds) {
    return refuse(c, ceilingReached("transcribe"));
  }
  // Held before the call, not billed after it: a second request arriving at
  // the same moment sees this one's seconds already spoken for.
  const held = await db.reserveUsage(c.env.DB, account.id, device.id, "transcribe", seconds, allowed.audio_seconds);
  if (!held) {
    const used = await db.usedThisPeriod(c.env.DB, account.id, "transcribe");
    return refuse(c, overAllowance("transcribe", used, seconds, allowed.audio_seconds));
  }

  const attempt = await transcribeUpstream(c, bytes, audio);
  if (!attempt.ok) {
    await db.releaseUsage(c.env.DB, held.id);
    return refuse(c, providerFailed(attempt.what, attempt.status));
  }

  const text = attempt.text.trim();
  // Audio seconds are known before the call, so settling confirms the
  // reservation rather than correcting it. It still has to happen: a
  // reservation nobody settles is swept back to the account in the end.
  await db.settleUsage(c.env.DB, held.id, seconds, attempt.provider);
  return c.json({ text, audio_seconds: seconds });
});

/**
 * A transcript in, the profile's summary object out.
 *
 * The prompt and the schema come from the device's own profile row, so a
 * caller cannot ask for a different system prompt or a different shape. The
 * only caller-supplied text besides the transcript is the subject and the
 * date, which are interpolated into a fixed frame and capped.
 */
proxy.post("/proxy/summarize", async (c) => {
  const account = c.get("account");
  const device = c.get("device");
  if (!account || !device) return c.json({ error: "not_a_device" }, 401);

  const tooLong = declaredLength(c.req.header("Content-Length"), MAX_SUMMARIZE_BYTES);
  if (tooLong) return refuse(c, tooLong);

  const gate = await db.hitRateLimit(c.env.DB, `summarize:${account.id}`, RATE_LIMITS.summarize, RATE_WINDOW_SECONDS);
  if (!gate.allowed) {
    return c.json({ error: "rate_limited", limit: RATE_LIMITS.summarize, window_seconds: RATE_WINDOW_SECONDS }, 429, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  const spec = profileSpec(device.profile);
  if (!spec) return c.json({ error: "unknown_profile" }, 400);

  const raw = await boundedBody(c, MAX_SUMMARIZE_BYTES);
  if (isRefusal(raw)) return refuse(c, raw);
  let body: { transcript?: unknown; subject?: unknown; course?: unknown; date?: unknown };
  try {
    // JSON.parse rather than req.json(): the bytes are already read and
    // already bounded. A body nested deeply enough to exhaust the stack
    // throws here like any other malformed input and is answered the same way.
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "bad_request", detail: "expected a JSON object" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "bad_request", detail: "expected a JSON object" }, 400);
  }
  const transcript = String(body.transcript ?? "");
  if (!transcript.trim()) return c.json({ error: "bad_request", detail: "transcript is empty" }, 400);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return c.json({ error: "too_large", limit_chars: MAX_TRANSCRIPT_CHARS }, 413);
  }
  // `course` is what the Mac has always called it; `subject` is the name that
  // fits both profiles. Either is accepted.
  const subject = label(body.subject ?? body.course) || "Unknown";
  const date = label(body.date);

  // Charged before the call on an estimate, then corrected to what the
  // response reports. Four characters to the token is the usual rule of
  // thumb and errs high on transcript prose, which is the safe direction.
  const estimate = Math.ceil(transcript.length / 4) + SUMMARY_MAX_TOKENS;
  const allowed = await allowanceFor(c.env.DB, account.id);
  await db.sweepReservations(c.env.DB, account.id);
  if ((await db.usedGlobally(c.env.DB, "summarize")) + estimate > GLOBAL_CEILING.summary_tokens) {
    return refuse(c, ceilingReached("summarize"));
  }
  // The estimate is held for the whole call and corrected to the real cost
  // below. Two summaries started together therefore cost the account two
  // estimates' worth of headroom, not one.
  const held = await db.reserveUsage(c.env.DB, account.id, device.id, "summarize", estimate, allowed.summary_tokens);
  if (!held) {
    const used = await db.usedThisPeriod(c.env.DB, account.id, "summarize");
    return refuse(c, overAllowance("summarize", used, estimate, allowed.summary_tokens));
  }

  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: spec.system,
        tools: [{ name: SUMMARY_TOOL, description: "Record the summary.", input_schema: spec.schema }],
        tool_choice: { type: "tool", name: SUMMARY_TOOL },
        messages: [{ role: "user", content: userMessage(spec, transcript, subject, date) }],
      }),
    });
  } catch {
    await db.releaseUsage(c.env.DB, held.id);
    return refuse(c, providerFailed("anthropic messages", 0));
  }
  if (!res.ok) {
    await db.releaseUsage(c.env.DB, held.id);
    return refuse(c, providerFailed("anthropic messages", res.status));
  }

  const answer = (await res.json().catch(() => null)) as {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  } | null;
  const tokens = (answer?.usage?.input_tokens ?? 0) + (answer?.usage?.output_tokens ?? 0);
  // Settled to whatever came back, because the tokens were spent either way.
  // A response that does not say costs the estimate rather than nothing, and
  // the unused part of the reservation goes back to the account here.
  await db.settleUsage(c.env.DB, held.id, tokens || estimate, "anthropic");

  const block = answer?.content?.find((b) => b.type === "tool_use" && b.name === SUMMARY_TOOL);
  // An empty object is a truthy object, so `block.input` being present is not
  // the same as a summary being present. Seen once in six runs on a 5,500 word
  // transcript: a tool_use block whose input carried none of the fields, which
  // went back as a 200 and reached the Mac as a blank note filed under the
  // fallback slug, already paid for. A summary with no summary in it is a
  // failed call, and the caller is told so rather than handed the blank.
  const summary = block?.input as Record<string, unknown> | undefined;
  const written = typeof summary?.summary_md === "string" ? summary.summary_md.trim() : "";
  if (!written) {
    console.log(`proxy: anthropic returned no summary (stop_reason=${answer?.stop_reason ?? "unknown"}, `
      + `keys=${summary ? Object.keys(summary).join("|") || "none" : "no input"})`);
    return c.json({ error: "no_summary", stop_reason: answer?.stop_reason ?? "" }, 502);
  }
  return c.json({ summary, tokens });
});

/**
 * A study question, answered from the student's own lectures.
 *
 * POST /proxy/assist (device bearer). The panel sends the material, the
 * conversation so far, and which of the three modes it is in. Everything
 * else is fixed here: the model, the system prompt, the tool, the effort,
 * where the cache breakpoints go, and how much any of it may cost.
 *
 * TWO-STAGE CONTEXT, which every margin number in HOME-STRETCH.md assumes.
 * A session normally carries course SUMMARIES only, about 15k tokens, and
 * most questions are answered from them. A question that needs the real
 * words of a lecture makes the model call open_course for ONE course; this
 * endpoint then answers nothing and tells the panel which course to load,
 * and the panel asks again with that course's transcripts in place of the
 * summaries, about 240k tokens. A study guide skips the asking: it always
 * needs the full course, so it escalates without spending a call to find out.
 *
 * That escalation is COUNTED, from the first session this service ever
 * serves. The tier table models 15% of sessions escalating and nobody has
 * ever measured it; at 50% the Sonnet month is $8.82 rather than $3.96 and
 * Pro at $22 stops working. `npm run escalation` reads it back.
 *
 * CACHING. The material is one text block with a 5-minute cache breakpoint
 * on it, and the question, the date and the mode go after it, so a session's
 * course transcripts are written once and read by every follow-up at a tenth
 * of the price. A second breakpoint on the end of the latest turn lets the
 * conversation itself accrue the same way. A read refreshes the TTL and a
 * study session is continuous, so five minutes stays warm for the whole of
 * it at 62% of what the 1-hour TTL would cost to write. The response's
 * cache_read_input_tokens is logged on every call: if it is zero across the
 * turns of one session, something in the prefix is varying and the session
 * is being paid for at full price.
 *
 * The conversation history belongs to the caller, not to this service: no
 * transcript, question, or answer is stored here, and what persists is a
 * usage row and a session row with counters in them. A caller can therefore
 * hand back a history that is not what was said. That shapes their own
 * answer and spends their own allowance, which is where it ends.
 */
type AssistBody = {
  session?: unknown;
  scope?: unknown;
  course?: unknown;
  mode?: unknown;
  documents?: unknown;
  messages?: unknown;
};

type Turn = { role: "user" | "assistant"; text: string };

/** The caller's JSON, or the refusal to send back. Nothing here reaches upstream unchecked. */
function readAssist(raw: unknown): { ok: true; value: AssistValid } | { ok: false; detail: string } {
  const body = raw as AssistBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, detail: "expected a JSON object" };

  const session = String(body.session ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
    return { ok: false, detail: `session must be 1 to ${MAX_SESSION_ID_CHARS} characters of A-Z a-z 0-9 _ -` };
  }

  const scope = body.scope === "course" ? "course" : body.scope === "summaries" ? "summaries" : null;
  if (!scope) return { ok: false, detail: "scope must be summaries or course" };

  const mode = String(body.mode ?? "ask") as AssistMode;
  if (!(mode in ASSIST_MODES)) return { ok: false, detail: "mode must be ask, study_guide or quiz" };

  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    return { ok: false, detail: "documents is required and must not be empty" };
  }
  if (body.documents.length > MAX_ASSIST_DOCUMENTS) {
    return { ok: false, detail: `at most ${MAX_ASSIST_DOCUMENTS} documents` };
  }
  const documents: StudyDocument[] = [];
  let chars = 0;
  for (const d of body.documents as Record<string, unknown>[]) {
    if (typeof d !== "object" || d === null) return { ok: false, detail: "each document must be an object" };
    const text = String(d.text ?? "").trim();
    if (!text) return { ok: false, detail: "each document needs text" };
    chars += text.length;
    if (chars > MAX_ASSIST_CONTEXT_CHARS) return { ok: false, detail: "too much material" };
    documents.push({ course: label(d.course) || "Unknown", date: label(d.date), title: label(d.title), text });
  }

  const courses = [...new Set(documents.map((d) => d.course))].sort();
  const course = label(body.course);
  if (scope === "course") {
    // One course, and the one the caller says it is. A "full course" request
    // carrying three courses would be the expensive path charged for the
    // cheap one, and would make the escalation rate a number about nothing.
    if (courses.length !== 1) return { ok: false, detail: "scope course takes the documents of exactly one course" };
    if (course && course !== courses[0]) return { ok: false, detail: "course does not match the documents sent" };
  }
  if (mode === "study_guide" && !course && courses.length !== 1) {
    return { ok: false, detail: "a study guide names one course" };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, detail: "messages is required and must not be empty" };
  }
  if (body.messages.length > MAX_ASSIST_MESSAGES) {
    return { ok: false, detail: `at most ${MAX_ASSIST_MESSAGES} messages` };
  }
  const messages: Turn[] = [];
  for (const m of body.messages as Record<string, unknown>[]) {
    if (typeof m !== "object" || m === null) return { ok: false, detail: "each message must be an object" };
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) return { ok: false, detail: "each message needs role user or assistant" };
    const text = String(m.content ?? "").trim();
    if (!text) return { ok: false, detail: "each message needs content" };
    if (text.length > MAX_ASSIST_MESSAGE_CHARS) {
      return { ok: false, detail: `a message may not exceed ${MAX_ASSIST_MESSAGE_CHARS} characters` };
    }
    messages.push({ role, text });
  }
  if (messages[0].role !== "user") return { ok: false, detail: "the first message must be the student's" };
  if (messages[messages.length - 1].role !== "user") {
    return { ok: false, detail: "the last message must be the student's" };
  }

  return { ok: true, value: { session, scope, mode, course: course || courses[0], courses, documents, messages, chars } };
}

type AssistValid = {
  session: string;
  scope: "summaries" | "course";
  mode: AssistMode;
  course: string;
  courses: string[];
  documents: StudyDocument[];
  messages: Turn[];
  chars: number;
};

/**
 * The request as Anthropic sees it, with the two cache breakpoints in it.
 *
 * Order is tools, then system, then messages, and the bytes ahead of a
 * breakpoint have to be identical on every turn for the cache to be read
 * rather than rewritten. So: the tool list is the courses sorted, the system
 * prompt is frozen, the material is sorted and framed by studyContext, and
 * the only thing that differs between one turn and the next is what has been
 * added since.
 *
 * Nothing is appended to the latest turn alone. Anything added there is
 * missing from that same turn once it is history, which moves the prefix
 * under the cache on the turn after it and quietly charges the whole
 * conversation again. The date therefore sits inside the material and the
 * mode goes on every student turn, both of which are the same bytes each
 * time this session is asked anything.
 */
function assistRequest(v: AssistValid, today: string): Record<string, unknown> {
  const mode = ASSIST_MODES[v.mode];
  const asked = (text: string) => (mode ? `${text}\n\n${mode}` : text);

  const messages: Record<string, unknown>[] = [
    {
      role: "user",
      content: [
        // Breakpoint one: tools, system prompt and every document, written
        // once a session and read by every follow-up at a tenth of the price.
        { type: "text", text: studyContext(v.documents, today), cache_control: { type: "ephemeral" } },
        { type: "text", text: asked(v.messages[0].text) },
      ],
    },
  ];
  for (const m of v.messages.slice(1)) {
    messages.push({ role: m.role, content: m.role === "user" ? asked(m.text) : m.text });
  }

  // Breakpoint two: the end of what has been said so far, so the conversation
  // accrues the same way the material did. The next turn reads through here.
  const last = messages[messages.length - 1];
  last.content = Array.isArray(last.content)
    ? (last.content as Record<string, unknown>[]).map((b, i, all) =>
        i === all.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b)
    : [{ type: "text", text: String(last.content), cache_control: { type: "ephemeral" } }];

  const request: Record<string, unknown> = {
    model: ASSIST_MODEL,
    max_tokens: ASSIST_MAX_TOKENS,
    // Adaptive is the only on-mode on this model; a budget_tokens is a 400.
    thinking: { type: "adaptive" },
    output_config: { effort: ASSIST_EFFORT },
    system: assistSystem(),
    messages,
  };
  // The escalation tool exists only on the cheap leg. Once a course is open
  // there is nothing further to ask for, and offering the tool anyway would
  // invite a second escalation that cannot be served.
  if (v.scope === "summaries") request.tools = [openCourseTool(v.courses)];
  return request;
}

proxy.post("/proxy/assist", async (c) => {
  const account = c.get("account");
  const device = c.get("device");
  if (!account || !device) return c.json({ error: "not_a_device" }, 401);

  const tooLong = declaredLength(c.req.header("Content-Length"), MAX_ASSIST_BYTES);
  if (tooLong) return refuse(c, tooLong);

  const gate = await db.hitRateLimit(c.env.DB, `assist:${account.id}`, RATE_LIMITS.assist, RATE_WINDOW_SECONDS);
  if (!gate.allowed) {
    return c.json({ error: "rate_limited", limit: RATE_LIMITS.assist, window_seconds: RATE_WINDOW_SECONDS }, 429, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  const bytes = await boundedBody(c, MAX_ASSIST_BYTES);
  if (isRefusal(bytes)) return refuse(c, bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: "bad_request", detail: "expected a JSON object" }, 400);
  }
  const read = readAssist(parsed);
  if (!read.ok) return c.json({ error: "bad_request", detail: read.detail }, 400);
  const v = read.value;

  const allowed = await allowanceFor(c.env.DB, account.id);
  // The session cap comes first: it is the cheapest refusal there is, and a
  // session is the unit a stolen device token would buy.
  const session = await db.openAssistSession(c.env.DB, account.id, v.session, device.id, allowed.assist_sessions);
  if (!session) {
    const sessions = await db.assistSessionsThisPeriod(c.env.DB, account.id);
    return c.json(
      {
        error: "session_cap_reached",
        started: sessions.started,
        allowance: allowed.assist_sessions,
        period: db.usagePeriod(),
      },
      402,
    );
  }

  const escalate = async (course: string) => {
    await db.markAssistEscalated(c.env.DB, account.id, v.session, course);
    console.log(`proxy: assist escalated session=${v.session} to ${course}`);
    return c.json({
      reply: "",
      escalate: { course },
      session: { id: v.session, turns: session.turns, escalated: true },
    });
  };

  // A study guide needs the instructor's own words and always has; asking the
  // model to discover that would cost a call to be told what is already known.
  if (v.mode === "study_guide" && v.scope === "summaries") return escalate(v.course);

  // Held before the call at what it would cost with nothing cached, then
  // corrected to what the response says it cost. Two questions asked at once
  // therefore hold two estimates' worth, which is the point of reserving.
  const estimate =
    Math.ceil((v.chars / 4) * ASSIST_WEIGHTS.cacheWrite) + ASSIST_MAX_TOKENS * ASSIST_WEIGHTS.output;
  await db.sweepReservations(c.env.DB, account.id);
  if ((await db.usedGlobally(c.env.DB, "assist")) + estimate > GLOBAL_CEILING.assist_units) {
    return refuse(c, ceilingReached("assist"));
  }
  const held = await db.reserveUsage(c.env.DB, account.id, device.id, "assist", estimate, allowed.assist_units);
  if (!held) {
    const used = await db.usedThisPeriod(c.env.DB, account.id, "assist");
    return refuse(c, overAllowance("assist", used, estimate, allowed.assist_units));
  }

  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(assistRequest(v, new Date().toISOString().slice(0, 10))),
    });
  } catch {
    await db.releaseUsage(c.env.DB, held.id);
    return refuse(c, providerFailed("anthropic assist", 0));
  }
  if (!res.ok) {
    await db.releaseUsage(c.env.DB, held.id);
    return refuse(c, providerFailed("anthropic assist", res.status));
  }

  const answer = (await res.json().catch(() => null)) as {
    content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason?: string;
  } | null;

  const used = answer?.usage ?? {};
  const write = used.cache_creation_input_tokens ?? 0;
  const cached = used.cache_read_input_tokens ?? 0;
  const units = Math.ceil(
    (used.input_tokens ?? 0) * ASSIST_WEIGHTS.input
      + write * ASSIST_WEIGHTS.cacheWrite
      + cached * ASSIST_WEIGHTS.cacheRead
      + (used.output_tokens ?? 0) * ASSIST_WEIGHTS.output,
  );
  // Settled to what came back, because the tokens were spent either way, and
  // the rest of the reservation goes back to the account here.
  await db.settleUsage(c.env.DB, held.id, units || estimate, "anthropic");
  // The line that says whether caching is working. On the second turn of a
  // session `cached` should be the whole of the material; a zero there across
  // a session means the prefix is varying and every turn is at full price.
  console.log(
    `proxy: assist ${v.scope} turn=${session.turns} fresh=${used.input_tokens ?? 0} write=${write} `
      + `read=${cached} out=${used.output_tokens ?? 0} units=${units}`,
  );

  const call = answer?.content?.find((b) => b.type === "tool_use" && b.name === OPEN_COURSE_TOOL);
  if (call) {
    const wanted = label(call.input?.course) || v.course;
    return escalate(v.courses.includes(wanted) ? wanted : v.courses[0]);
  }

  const reply = (answer?.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  if (!reply) {
    console.log(`proxy: assist returned no text (stop_reason=${answer?.stop_reason ?? "unknown"})`);
    return c.json({ error: "no_reply", stop_reason: answer?.stop_reason ?? "" }, 502);
  }
  return c.json({
    reply,
    escalate: null,
    units,
    truncated: answer?.stop_reason === "max_tokens",
    usage: { input: used.input_tokens ?? 0, cache_write: write, cache_read: cached, output: used.output_tokens ?? 0 },
    session: { id: v.session, turns: session.turns, escalated: session.escalated === 1 },
  });
});

/**
 * Characters of transcript per second of lecture audio.
 *
 * Measured on real lectures through this service: 3,880 seconds produced
 * 49,898 characters, 4,328 produced about 52,000, 2,979 about 28,000. Twelve
 * sits in the middle and errs high, which is the safe direction for a number
 * whose only job is to warn somebody before they record.
 */
const TRANSCRIPT_CHARS_PER_SECOND = 12;

/**
 * How much more lecture this account can take all the way through, in seconds.
 *
 * Both meters have to carry a recording: the audio is charged in seconds and
 * the summary of that same audio is charged in tokens. A panel told only the
 * audio figure would promise an hour the summary cannot pay for, which is
 * exactly what happened the day this was written. The account had 101 minutes
 * of audio left, room for a 58-minute summary, and recorded for 65.
 *
 * The summary's reservation carries a fixed floor, SUMMARY_MAX_TOKENS, held
 * for output that has not been generated yet. An account with less than that
 * left can summarize nothing at all, whatever its audio balance says, so the
 * floor is subtracted before the rest is converted into seconds.
 */
function recordableSeconds(audioLeft: number, tokensLeft: number): number {
  const forSummary = tokensLeft <= SUMMARY_MAX_TOKENS
    ? 0
    : Math.floor(((tokensLeft - SUMMARY_MAX_TOKENS) * 4) / TRANSCRIPT_CHARS_PER_SECOND);
  return Math.max(0, Math.min(audioLeft, forSummary));
}

/** What is left this month, for a panel that wants to say so before recording. */
proxy.get("/proxy/usage", async (c) => {
  const account = c.get("account");
  if (!account) return c.json({ error: "not_signed_in" }, 401);
  const allowed = await allowanceFor(c.env.DB, account.id);
  const [audio, tokens, assist, sessions, split] = await Promise.all([
    db.usedThisPeriod(c.env.DB, account.id, "transcribe"),
    db.usedThisPeriod(c.env.DB, account.id, "summarize"),
    db.usedThisPeriod(c.env.DB, account.id, "assist"),
    db.assistSessionsThisPeriod(c.env.DB, account.id),
    db.providerSplit(c.env.DB, account.id, "transcribe"),
  ]);
  const audioLeft = Math.max(0, allowed.audio_seconds - audio);
  const tokensLeft = Math.max(0, allowed.summary_tokens - tokens);
  return c.json({
    period: db.usagePeriod(),
    source: allowed.source,
    audio_seconds: { used: audio, allowance: allowed.audio_seconds, left: audioLeft },
    summary_tokens: { used: tokens, allowance: allowed.summary_tokens, left: tokensLeft },
    // The assistant's two meters. Units are input-token equivalents at the
    // Sonnet input rate (ASSIST_WEIGHTS), so they are money rather than
    // tokens; sessions are what the hard cap is written in.
    assist_units: { used: assist, allowance: allowed.assist_units, left: Math.max(0, allowed.assist_units - assist) },
    assist_sessions: {
      used: sessions.started,
      allowance: allowed.assist_sessions,
      left: Math.max(0, allowed.assist_sessions - sessions.started),
      // What share of this account's sessions needed a whole course. Modeled
      // at 15% and never measured; Pro's margin moves with it.
      escalated: sessions.escalated,
    },
    // The one number a panel can act on. Working it out here rather than
    // there keeps it next to the reservation rules it is derived from; a
    // panel doing its own arithmetic would drift the first time they change.
    recordable_seconds: recordableSeconds(audioLeft, tokensLeft),
    // Which provider transcribed this account's audio this period. Groq is
    // $0.111 an hour and the OpenAI fallback is $0.18, so a month is only as
    // cheap as this says it was. "unrecorded" is a call from before the
    // provider was written down, not a third provider.
    transcribed_by: Object.fromEntries(
      split.map((row) => [row.provider || "unrecorded", { calls: row.calls, seconds: row.units }]),
    ),
  });
});
