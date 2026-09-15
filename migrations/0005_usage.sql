-- What an account has spent through the proxy, and what it is allowed to spend.
--
-- The proxy (src/proxy.ts) holds the OpenAI and Anthropic keys, so every call
-- through it spends real money on somebody else's behalf. These three tables
-- are what keeps that bounded.
--
-- usage is append-only: one row per upstream call that actually happened,
-- carrying the account it is billed to, the device that asked, what kind of
-- work it was, and how many units it consumed. Units are audio seconds for
-- transcribe and tokens (input plus output) for summarize, so the two kinds
-- are never summed together. period is the YYYY-MM the row counts against,
-- stored rather than derived so the monthly total is one indexed scan.
--
-- No audio and no transcript text is ever written here. A usage row and its
-- unit count are all that persist.
--
-- allowances is what an account may spend per month. A missing row means the
-- defaults in src/proxy.ts, which is every account today. Slice 4 (Stripe and
-- entitlements) is what starts writing rows here; nothing else should.
--
-- rate_limits is a fixed-window counter, one row per bucket per window. It is
-- swept opportunistically rather than kept.

CREATE TABLE usage (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  units      INTEGER NOT NULL,
  period     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX usage_by_period ON usage (account_id, kind, period);

CREATE TABLE allowances (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  audio_seconds  INTEGER NOT NULL,
  summary_tokens INTEGER NOT NULL,
  source         TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL
);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
