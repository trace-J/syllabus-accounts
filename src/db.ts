/** Every query in one place, typed against the rows in migrations/. */

import type { Account, Device } from "./env";
import type { AllowanceGrant } from "./tiers";
import { now, randomId } from "./util";

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string;
  picture: string;
};

/** The account for a Google identity, created on first sign-in. */
export async function upsertAccount(db: D1Database, who: GoogleIdentity): Promise<Account> {
  const existing = await db
    .prepare("SELECT * FROM accounts WHERE google_sub = ?")
    .bind(who.sub)
    .first<Account>();
  const ts = now();
  if (existing) {
    // Email and name follow Google; a person who renames their account
    // should see the new name here on their next sign-in.
    await db
      .prepare("UPDATE accounts SET email = ?, name = ?, picture = ?, last_signin_at = ? WHERE id = ?")
      .bind(who.email, who.name, who.picture, ts, existing.id)
      .run();
    return { ...existing, email: who.email, name: who.name, picture: who.picture, last_signin_at: ts };
  }
  const account: Account = {
    id: randomId(12),
    google_sub: who.sub,
    email: who.email,
    name: who.name,
    picture: who.picture,
    created_at: ts,
    last_signin_at: ts,
    token_version: 0,
  };
  await db
    .prepare(
      "INSERT INTO accounts (id, google_sub, email, name, picture, created_at, last_signin_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(account.id, account.google_sub, account.email, account.name, account.picture, account.created_at, account.last_signin_at)
    .run();
  return account;
}

export async function accountById(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

export async function devicesOf(db: D1Database, accountId: string): Promise<Device[]> {
  const res = await db
    .prepare("SELECT * FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at")
    .bind(accountId)
    .all<Device>();
  return res.results;
}

export async function createDevice(
  db: D1Database,
  accountId: string,
  name: string,
  profile: string,
): Promise<Device> {
  const ts = now();
  const device: Device = {
    id: randomId(12),
    account_id: accountId,
    name,
    profile,
    created_at: ts,
    last_seen_at: ts,
    revoked_at: null,
  };
  await db
    .prepare(
      "INSERT INTO devices (id, account_id, name, profile, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(device.id, device.account_id, device.name, device.profile, device.created_at, device.last_seen_at)
    .run();
  return device;
}

/** Revoke a device and every token it holds. Only the owner's devices qualify. */
export async function revokeDevice(db: D1Database, accountId: string, deviceId: string): Promise<boolean> {
  const ts = now();
  const res = await db
    .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(ts, deviceId, accountId)
    .run();
  if (!res.meta.changes) return false;
  await db
    .prepare("UPDATE device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
    .bind(ts, deviceId)
    .run();
  return true;
}

export async function insertDeviceToken(
  db: D1Database,
  tokenHash: string,
  deviceId: string,
  tokenVersion: number,
): Promise<void> {
  await db
    .prepare("INSERT INTO device_tokens (token_hash, device_id, created_at, token_version) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, deviceId, now(), tokenVersion)
    .run();
}

/**
 * Incident recovery: every token on this account stops working at once, and
 * every device is removed. One statement bumps the account past every token
 * ever issued under it, so a replacement enrolled by a stolen token dies with
 * the token that enrolled it. Returns how many devices were removed.
 */
export async function revokeEverything(db: D1Database, accountId: string): Promise<number> {
  const ts = now();
  await db.prepare("UPDATE accounts SET token_version = token_version + 1 WHERE id = ?").bind(accountId).run();
  await db
    .prepare("UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE account_id = ?)")
    .bind(ts, accountId)
    .run();
  const res = await db
    .prepare("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
    .bind(ts, accountId)
    .run();
  return res.meta.changes ?? 0;
}

/** The live device and account behind a token hash, or null for anything revoked or unknown. */
export async function resolveDeviceToken(
  db: D1Database,
  tokenHash: string,
): Promise<{ device: Device; account: Account } | null> {
  const row = await db
    .prepare(
      `SELECT d.id AS d_id, d.account_id AS d_account_id, d.name AS d_name, d.profile AS d_profile,
              d.created_at AS d_created_at, d.last_seen_at AS d_last_seen_at,
              d.revoked_at AS d_revoked_at, a.*
         FROM device_tokens t
         JOIN devices d ON d.id = t.device_id
         JOIN accounts a ON a.id = d.account_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL
          AND t.token_version = a.token_version`,
    )
    .bind(tokenHash)
    .first<Record<string, string | null>>();
  if (!row) return null;
  const device: Device = {
    id: row.d_id as string,
    account_id: row.d_account_id as string,
    name: row.d_name as string,
    profile: row.d_profile as string,
    created_at: row.d_created_at as string,
    last_seen_at: row.d_last_seen_at as string,
    revoked_at: row.d_revoked_at,
  };
  const account: Account = {
    id: row.id as string,
    google_sub: row.google_sub as string,
    email: row.email as string,
    name: row.name as string,
    picture: row.picture as string,
    created_at: row.created_at as string,
    last_signin_at: row.last_signin_at as string,
    token_version: Number(row.token_version ?? 0),
  };
  return { device, account };
}

export async function touchDevice(db: D1Database, deviceId: string): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now(), deviceId).run();
}

export async function revokeDeviceToken(db: D1Database, tokenHash: string): Promise<void> {
  await db
    .prepare("UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(now(), tokenHash)
    .run();
}

// --- Device codes: one claim in progress ------------------------------------

export type DeviceCode = {
  device_code_hash: string;
  user_code: string;
  profile: string;
  device_name: string;
  created_at: string;
  expires_at: string;
  approved_account_id: string | null;
  approved_device_id: string | null;
  collected_at: string | null;
};

export async function insertDeviceCode(
  db: D1Database,
  deviceCodeHash: string,
  userCode: string,
  profile: string,
  deviceName: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO device_codes (device_code_hash, user_code, profile, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(deviceCodeHash, userCode, profile, deviceName, now(), expiresAt)
    .run();
}

export async function deviceCodeByUserCode(db: D1Database, userCode: string): Promise<DeviceCode | null> {
  return db.prepare("SELECT * FROM device_codes WHERE user_code = ?").bind(userCode).first<DeviceCode>();
}

export async function deviceCodeByHash(db: D1Database, hash: string): Promise<DeviceCode | null> {
  return db.prepare("SELECT * FROM device_codes WHERE device_code_hash = ?").bind(hash).first<DeviceCode>();
}

export async function approveDeviceCode(
  db: D1Database,
  hash: string,
  accountId: string,
  deviceId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE device_codes SET approved_account_id = ?, approved_device_id = ? WHERE device_code_hash = ? AND approved_account_id IS NULL",
    )
    .bind(accountId, deviceId, hash)
    .run();
  return res.meta.changes > 0;
}

/** Mark a code collected. False if it already was, so a token is handed out once. */
export async function collectDeviceCode(db: D1Database, hash: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE device_codes SET collected_at = ? WHERE device_code_hash = ? AND collected_at IS NULL")
    .bind(now(), hash)
    .run();
  return res.meta.changes > 0;
}

/** Codes past their expiry are of no further use; clear them opportunistically. */
export async function sweepDeviceCodes(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now()).run();
}

/** Claims in progress right now: the number the pending cap is set against. */
export async function pendingDeviceCodes(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM device_codes WHERE expires_at >= ? AND approved_account_id IS NULL")
    .bind(now())
    .first<{ total: number }>();
  return row?.total ?? 0;
}

// --- Devices -----------------------------------------------------------------

export async function deviceById(db: D1Database, id: string): Promise<Device | null> {
  return db.prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").bind(id).first<Device>();
}

// --- Settings documents ------------------------------------------------------

export type Setting = {
  account_id: string;
  profile: string;
  name: string;
  content: string;
  updated_at: string;
  updated_by: string;
};

export async function getSetting(db: D1Database, accountId: string, profile: string, name: string): Promise<Setting | null> {
  return db
    .prepare("SELECT * FROM settings WHERE account_id = ? AND profile = ? AND name = ?")
    .bind(accountId, profile, name)
    .first<Setting>();
}

/**
 * Write a document. With `expected` set, the write only happens when the
 * current updated_at equals it (or nothing is stored yet and expected is
 * ""), so two Macs cannot silently overwrite each other. Returns the row as
 * stored, or null when the expectation failed.
 */
export async function putSetting(
  db: D1Database,
  accountId: string,
  profile: string,
  name: string,
  content: string,
  updatedBy: string,
  expected: string | null,
): Promise<Setting | null> {
  const ts = now();
  const current = await getSetting(db, accountId, profile, name);
  if (expected !== null && (current?.updated_at ?? "") !== expected) return null;
  // updated_at is the version, so two writes in one millisecond must differ.
  const stamp = current && current.updated_at >= ts ? new Date(Date.parse(current.updated_at) + 1).toISOString() : ts;
  await db
    .prepare(
      `INSERT INTO settings (account_id, profile, name, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, profile, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(accountId, profile, name, content, stamp, updatedBy)
    .run();
  return { account_id: accountId, profile, name, content, updated_at: stamp, updated_by: updatedBy };
}

// --- Drive grants ----------------------------------------------------------------

export type DriveGrant = {
  account_id: string;
  refresh_token_enc: string;
  scopes: string;
  google_email: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_reason: string;
};

export async function driveGrant(db: D1Database, accountId: string): Promise<DriveGrant | null> {
  return db.prepare("SELECT * FROM drive_grants WHERE account_id = ?").bind(accountId).first<DriveGrant>();
}

export async function putDriveGrant(
  db: D1Database,
  accountId: string,
  refreshTokenEnc: string,
  scopes: string,
  googleEmail: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drive_grants (account_id, refresh_token_enc, scopes, google_email, granted_at, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, NULL, '')
       ON CONFLICT (account_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes,
         google_email = excluded.google_email, granted_at = excluded.granted_at, revoked_at = NULL, revoked_reason = ''`,
    )
    .bind(accountId, refreshTokenEnc, scopes, googleEmail, now())
    .run();
}

export async function markDriveGrantRevoked(db: D1Database, accountId: string, reason: string): Promise<void> {
  await db
    .prepare("UPDATE drive_grants SET revoked_at = ?, revoked_reason = ? WHERE account_id = ? AND revoked_at IS NULL")
    .bind(now(), reason, accountId)
    .run();
}

export async function deleteDriveGrant(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("DELETE FROM drive_grants WHERE account_id = ?").bind(accountId).run();
}

// --- Proxy usage, allowances, and rate limiting ------------------------------

export type UsageKind = "transcribe" | "summarize";

export type Allowance = {
  account_id: string;
  audio_seconds: number;
  summary_tokens: number;
  /** Pro's study sessions. Written, never enforced yet; see migrations/0010. */
  assistant_sessions: number;
  source: string;
  updated_at: string;
};

/** The YYYY-MM a usage row counts against. Months are UTC, everywhere. */
export function usagePeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export async function allowance(db: D1Database, accountId: string): Promise<Allowance | null> {
  return db.prepare("SELECT * FROM allowances WHERE account_id = ?").bind(accountId).first<Allowance>();
}

/**
 * Write what an account may spend. Only the Stripe webhook should call this.
 *
 * The grant is the shape src/tiers.ts produces, so the entitlement rules and
 * the row they become never drift apart.
 */
export async function putAllowance(db: D1Database, accountId: string, grant: AllowanceGrant): Promise<void> {
  await db
    .prepare(
      `INSERT INTO allowances (account_id, audio_seconds, summary_tokens, assistant_sessions, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET audio_seconds = excluded.audio_seconds,
         summary_tokens = excluded.summary_tokens, assistant_sessions = excluded.assistant_sessions,
         source = excluded.source, updated_at = excluded.updated_at`,
    )
    .bind(accountId, grant.audio_seconds, grant.summary_tokens, grant.assistant_sessions, grant.source, now())
    .run();
}

/** Units of `kind` this account has already spent this period. */
export async function usedThisPeriod(
  db: D1Database,
  accountId: string,
  kind: UsageKind,
  period = usagePeriod(),
): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(units), 0) AS total FROM usage WHERE account_id = ? AND kind = ? AND period = ?")
    .bind(accountId, kind, period)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** One upstream call that happened. Never carries audio or transcript text. */
export async function recordUsage(
  db: D1Database,
  accountId: string,
  deviceId: string,
  kind: UsageKind,
  units: number,
  provider = "",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage (id, account_id, device_id, kind, units, period, created_at, state, provider)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, 'final', ?)",
    )
    .bind(randomId(12), accountId, deviceId, kind, Math.max(0, Math.round(units)), usagePeriod(), now(), provider)
    .run();
}

/**
 * How one account's work this period split across the providers that served it.
 *
 * This is the question a fallback makes worth asking: transcription runs on
 * Groq at $0.111 an hour and falls back to OpenAI at $0.18, so the share on
 * each leg is the difference between a forecast and a guess.
 *
 * Scoped to one account because that is whose data it is. The fleet-wide
 * version of this query is an operator's, not an endpoint's; it is
 * `npm run split` and it goes straight at D1.
 *
 * Reservations are excluded: a call still in flight has no provider yet, and
 * counting it would put a live call in the "unrecorded" bucket and make the
 * record look holed. Rows come back busiest first.
 */
export async function providerSplit(
  db: D1Database,
  accountId: string,
  kind: UsageKind,
  period = usagePeriod(),
): Promise<{ provider: string; calls: number; units: number }[]> {
  const rows = await db
    .prepare(
      `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(units), 0) AS units
         FROM usage
        WHERE account_id = ? AND kind = ? AND period = ? AND state = 'final'
        GROUP BY provider
        ORDER BY units DESC`,
    )
    .bind(accountId, kind, period)
    .all<{ provider: string; calls: number; units: number }>();
  return rows.results ?? [];
}

/** How long a reservation may sit before it is treated as a Worker that died. */
export const RESERVATION_SECONDS = 900;

/**
 * Take `units` out of the account's allowance before the call, or refuse.
 *
 * The check and the write are one statement on purpose. Summing the period
 * and then inserting is two, and two concurrent requests both read the sum
 * from before either wrote, so both were told there was room for them. Here
 * the INSERT only happens if its own WHERE still holds, and SQLite runs the
 * whole statement as one; the loser inserts nothing and gets null back.
 *
 * Returns the reservation id to settle or release, or null when there is not
 * enough left. `used` in the refusal is what the total was at that moment,
 * reservations included.
 */
export async function reserveUsage(
  db: D1Database,
  accountId: string,
  deviceId: string,
  kind: UsageKind,
  units: number,
  allowed: number,
): Promise<{ id: string } | null> {
  const want = Math.max(0, Math.round(units));
  const period = usagePeriod();
  const row = await db
    .prepare(
      `INSERT INTO usage (id, account_id, device_id, kind, units, period, created_at, state)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'reserved'
        WHERE (SELECT COALESCE(SUM(units), 0) FROM usage
                WHERE account_id = ? AND kind = ? AND period = ?) + ? <= ?
       RETURNING id`,
    )
    .bind(randomId(12), accountId, deviceId, kind, want, period, now(), accountId, kind, period, want, allowed)
    .first<{ id: string }>();
  return row ? { id: row.id } : null;
}

/**
 * The call happened and cost this much. The reservation becomes the bill.
 *
 * `provider` is who actually served it, which is only knowable now: the
 * reservation was written before the call, and on the transcribe path the
 * provider is whichever leg answered. Left empty it means "not recorded",
 * which is what every row from before this column says.
 */
export async function settleUsage(
  db: D1Database,
  id: string,
  units: number,
  provider = "",
): Promise<void> {
  await db
    .prepare("UPDATE usage SET units = ?, provider = ?, state = 'final' WHERE id = ? AND state = 'reserved'")
    .bind(Math.max(0, Math.round(units)), provider, id)
    .run();
}

/** The call did not happen, or failed. Give the allowance back. */
export async function releaseUsage(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM usage WHERE id = ? AND state = 'reserved'").bind(id).run();
}

/**
 * Drop reservations nothing will ever settle.
 *
 * A Worker that is killed between reserving and settling leaves a row holding
 * allowance for a call that never happened. Nothing upstream takes anywhere
 * near RESERVATION_SECONDS, so anything older than that is wreckage.
 */
export async function sweepReservations(db: D1Database, accountId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RESERVATION_SECONDS * 1000).toISOString();
  await db
    .prepare("DELETE FROM usage WHERE state = 'reserved' AND account_id = ? AND created_at < ?")
    .bind(accountId, cutoff)
    .run();
}

/**
 * What every account together has spent this period: the circuit breaker.
 *
 * Per-account allowances bound what one caller costs. They do not bound what
 * a bad afternoon costs, and the number that reaches a card is this one.
 */
export async function usedGlobally(db: D1Database, kind: UsageKind, period = usagePeriod()): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(units), 0) AS total FROM usage WHERE kind = ? AND period = ?")
    .bind(kind, period)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Count one request against a fixed window and say whether it is over.
 *
 * The increment and the read are one statement, so two requests arriving
 * together cannot both see the lower count. Fixed windows let through up to
 * twice the limit across a window boundary, which is the accepted cost of
 * not keeping per-request timestamps: the money cap is the allowance, and
 * this only has to stop a flood.
 */
export async function hitRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
  at: number = Date.now(),
): Promise<{ allowed: boolean; count: number; retryAfter: number }> {
  const windowStart = Math.floor(at / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return {
    allowed: count <= limit,
    count,
    retryAfter: Math.max(1, windowStart + windowSeconds - Math.floor(at / 1000)),
  };
}

/** Windows that have closed are of no further use; clear them opportunistically. */
export async function sweepRateLimits(db: D1Database, before: number): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(before).run();
}

// --- Stripe subscriptions and webhook events --------------------------------

/**
 * One row of migrations/0010: what Stripe last said about a subscription.
 *
 * `tier` is resolved from `price_id` when the row is written, so a price
 * retired in the dashboard does not make old rows unreadable. The entitlement
 * rules that read all of this live in src/tiers.ts.
 */
export type Subscription = {
  stripe_subscription_id: string;
  account_id: string;
  stripe_customer_id: string;
  price_id: string;
  tier: string;
  status: string;
  /** ISO 8601 UTC, or '' when Stripe did not send one. */
  current_period_end: string;
  /** 0 or 1. SQLite has no boolean. */
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
};

/** Every subscription an account holds, oldest first. Usually one. */
export async function subscriptionsOf(db: D1Database, accountId: string): Promise<Subscription[]> {
  const res = await db
    .prepare("SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at")
    .bind(accountId)
    .all<Subscription>();
  return res.results;
}

export async function subscriptionById(db: D1Database, stripeSubscriptionId: string): Promise<Subscription | null> {
  return db
    .prepare("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?")
    .bind(stripeSubscriptionId)
    .first<Subscription>();
}

/** Which account a Stripe customer belongs to, or null if we have never seen one. */
export async function accountIdForCustomer(db: D1Database, stripeCustomerId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT account_id FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(stripeCustomerId)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/**
 * Record what Stripe says about a subscription, creating or updating the row.
 *
 * `created_at` is when we first heard of the subscription, not when Stripe
 * created it, and is left alone on an update: it is what orders an account's
 * rows when none of them entitles any more.
 */
export async function putSubscription(
  db: D1Database,
  sub: Omit<Subscription, "created_at" | "updated_at">,
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, account_id, stripe_customer_id, price_id, tier, status,
         current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET account_id = excluded.account_id,
         stripe_customer_id = excluded.stripe_customer_id, price_id = excluded.price_id, tier = excluded.tier,
         status = excluded.status, current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
    )
    .bind(
      sub.stripe_subscription_id,
      sub.account_id,
      sub.stripe_customer_id,
      sub.price_id,
      sub.tier,
      sub.status,
      sub.current_period_end,
      sub.cancel_at_period_end ? 1 : 0,
      ts,
      ts,
    )
    .run();
}

/**
 * Claim a Stripe event id, or say it was already handled.
 *
 * True means this delivery is the first and the handler should run. The claim
 * is the INSERT itself rather than a SELECT followed by one, so two deliveries
 * arriving together cannot both find nothing and both grant a month.
 */
export async function claimStripeEvent(
  db: D1Database,
  eventId: string,
  type: string,
  accountId = "",
): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO stripe_events (id, type, account_id, received_at) VALUES (?, ?, ?, ?)")
    .bind(eventId, type, accountId, now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Give an event id back, so Stripe's retry is handled rather than skipped.
 *
 * The claim is held only for events that were actually dealt with. A handler
 * that failed, or one that could not work out whose event it was, releases it
 * and answers 500; Stripe then retries, and the retry finds nothing claimed.
 */
export async function releaseStripeEvent(db: D1Database, eventId: string): Promise<void> {
  await db.prepare("DELETE FROM stripe_events WHERE id = ?").bind(eventId).run();
}

/** Attach the account to an event that was claimed before we knew whose it was. */
export async function attributeStripeEvent(db: D1Database, eventId: string, accountId: string): Promise<void> {
  await db
    .prepare("UPDATE stripe_events SET account_id = ? WHERE id = ? AND account_id = ''")
    .bind(accountId, eventId)
    .run();
}

/**
 * Remember which account a Stripe customer is, learned at checkout.
 *
 * Kept after a subscription ends: somebody who resubscribes arrives as the
 * same customer, and the alternative is a webhook that cannot be attributed.
 * The first writer wins, because a customer belongs to one account and a
 * later event claiming otherwise is a bug rather than a move.
 */
export async function linkStripeCustomer(
  db: D1Database,
  stripeCustomerId: string,
  accountId: string,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO stripe_customers (stripe_customer_id, account_id, created_at) VALUES (?, ?, ?)")
    .bind(stripeCustomerId, accountId, now())
    .run();
}

/** The Stripe customer an account is, if it has ever reached checkout. */
export async function stripeCustomerOf(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT stripe_customer_id FROM stripe_customers WHERE account_id = ? ORDER BY created_at LIMIT 1")
    .bind(accountId)
    .first<{ stripe_customer_id: string }>();
  return row?.stripe_customer_id ?? null;
}

/** The account a Stripe customer belongs to, from the link made at checkout. */
export async function accountIdForLinkedCustomer(db: D1Database, stripeCustomerId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT account_id FROM stripe_customers WHERE stripe_customer_id = ?")
    .bind(stripeCustomerId)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/**
 * Hours somebody bought on top of their plan, this period.
 *
 * Summed rather than kept as a running balance, for the same reason usage is:
 * two purchases landing together cannot disagree about a total that is
 * derived. A period with no top-ups is two zeros, which is every account
 * almost all of the time.
 */
export async function topupsThisPeriod(
  db: D1Database,
  accountId: string,
  period = usagePeriod(),
): Promise<{ audio_seconds: number; summary_tokens: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(audio_seconds), 0) AS audio_seconds, COALESCE(SUM(summary_tokens), 0) AS summary_tokens
       FROM topups WHERE account_id = ? AND period = ?`,
    )
    .bind(accountId, period)
    .first<{ audio_seconds: number; summary_tokens: number }>();
  return { audio_seconds: row?.audio_seconds ?? 0, summary_tokens: row?.summary_tokens ?? 0 };
}

/**
 * Record a top-up somebody paid for. Only the Stripe webhook should call this.
 *
 * The Stripe Checkout session id is the primary key, so a redelivered
 * `checkout.session.completed` cannot grant the same hours twice even if the
 * claim in stripe_events were somehow lost. Returns whether this call is what
 * granted them.
 */
export async function recordTopup(
  db: D1Database,
  stripeSessionId: string,
  accountId: string,
  audioSeconds: number,
  summaryTokens: number,
  period = usagePeriod(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO topups (stripe_session_id, account_id, period, audio_seconds, summary_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(stripeSessionId, accountId, period, audioSeconds, summaryTokens, now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
