/**
 * The managed-key proxy: the two paid calls, made from here instead of a Mac.
 *
 *   POST /proxy/transcribe   (device bearer) one audio chunk -> transcript text
 *   POST /proxy/summarize    (device bearer) a transcript -> the summary object
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
 * the two labels that frame it, and that is all.
 *
 * Three things bound the damage from a stolen device token, which used to
 * read somebody's own data and now spends money:
 *
 *   1. A monthly allowance per account, checked BEFORE the upstream call.
 *      Slice 4 (Stripe) writes real allowances; until then every account gets
 *      TRIAL_ALLOWANCE below.
 *   2. A per-minute rate limit per account on both endpoints, so a token that
 *      leaks cannot burn a month's allowance in a minute.
 *   3. Hard caps on request size and on transcript length, refused before
 *      anything is read or forwarded.
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
import { profileSpec, userMessage } from "./prompts";

// --- What is fixed here, and not by a caller --------------------------------

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SUMMARY_MODEL = "claude-sonnet-5";
const SUMMARY_MAX_TOKENS = 16000;
const SUMMARY_TOOL = "record_summary";

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
const RATE_LIMITS = { transcribe: 20, summarize: 5 } as const;

/**
 * The allowance an account has before slice 4 gives it a real one: the
 * 5-hour trial. Audio is metered in seconds, summaries in tokens (input plus
 * output). 5 hours of lecture needs about 48k summary tokens, so the token
 * figure is headroom for retries rather than a second product limit.
 */
export const TRIAL_ALLOWANCE = { audio_seconds: 5 * 3600, summary_tokens: 150_000 };

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
      unit: kind === "transcribe" ? "audio_seconds" : "tokens",
      used,
      requested: wanted,
      allowance: allowed,
      period: db.usagePeriod(),
    },
  };
}

/** The account's allowance for the month: its own row, or the trial default. */
async function allowanceFor(database: D1Database, accountId: string) {
  const row = await db.allowance(database, accountId);
  return {
    audio_seconds: row?.audio_seconds ?? TRIAL_ALLOWANCE.audio_seconds,
    summary_tokens: row?.summary_tokens ?? TRIAL_ALLOWANCE.summary_tokens,
    source: row?.source || "trial",
  };
}

function declaredLength(header: string | undefined, cap: number): Refusal | null {
  const length = Number(header ?? "");
  if (Number.isFinite(length) && length > cap) {
    return { status: 413, body: { error: "too_large", limit_bytes: cap } };
  }
  return null;
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

  let form: FormData;
  try {
    form = await c.req.formData();
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
  const used = await db.usedThisPeriod(c.env.DB, account.id, "transcribe");
  if (used + seconds > allowed.audio_seconds) {
    return refuse(c, overAllowance("transcribe", used, seconds, allowed.audio_seconds));
  }

  // Rebuilt rather than forwarded, so only these three fields reach OpenAI.
  const upstream = new FormData();
  upstream.set("file", new Blob([bytes], { type: audio.type || "audio/mp4" }), audio.name || "chunk.m4a");
  upstream.set("model", TRANSCRIBE_MODEL);
  upstream.set("response_format", "text");

  let res: Response;
  try {
    res = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}` },
      body: upstream,
    });
  } catch {
    return refuse(c, providerFailed("openai transcription", 0));
  }
  if (!res.ok) return refuse(c, providerFailed("openai transcription", res.status));

  const text = (await res.text()).trim();
  await db.recordUsage(c.env.DB, account.id, device.id, "transcribe", seconds);
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

  let body: { transcript?: unknown; subject?: unknown; course?: unknown; date?: unknown };
  try {
    body = await c.req.json();
  } catch {
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
  const used = await db.usedThisPeriod(c.env.DB, account.id, "summarize");
  if (used + estimate > allowed.summary_tokens) {
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
    return refuse(c, providerFailed("anthropic messages", 0));
  }
  if (!res.ok) return refuse(c, providerFailed("anthropic messages", res.status));

  const answer = (await res.json().catch(() => null)) as {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  } | null;
  const tokens = (answer?.usage?.input_tokens ?? 0) + (answer?.usage?.output_tokens ?? 0);
  // Billed whatever came back, because the tokens were spent either way.
  await db.recordUsage(c.env.DB, account.id, device.id, "summarize", tokens || estimate);

  const block = answer?.content?.find((b) => b.type === "tool_use" && b.name === SUMMARY_TOOL);
  if (!block?.input) {
    console.log(`proxy: anthropic returned no summary (stop_reason=${answer?.stop_reason ?? "unknown"})`);
    return c.json({ error: "no_summary", stop_reason: answer?.stop_reason ?? "" }, 502);
  }
  return c.json({ summary: block.input, tokens });
});

/** What is left this month, for a panel that wants to say so before recording. */
proxy.get("/proxy/usage", async (c) => {
  const account = c.get("account");
  if (!account) return c.json({ error: "not_signed_in" }, 401);
  const allowed = await allowanceFor(c.env.DB, account.id);
  const [audio, tokens] = await Promise.all([
    db.usedThisPeriod(c.env.DB, account.id, "transcribe"),
    db.usedThisPeriod(c.env.DB, account.id, "summarize"),
  ]);
  return c.json({
    period: db.usagePeriod(),
    source: allowed.source,
    audio_seconds: { used: audio, allowance: allowed.audio_seconds },
    summary_tokens: { used: tokens, allowance: allowed.summary_tokens },
  });
});
