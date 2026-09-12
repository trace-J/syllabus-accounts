/** Every query in one place, typed against the rows in migrations/. */

import type { Account, Device } from "./env";
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
    public_url: "",
    created_at: ts,
    last_seen_at: ts,
    revoked_at: null,
  };
  await db
    .prepare(
      "INSERT INTO devices (id, account_id, name, profile, public_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device.id, device.account_id, device.name, device.profile, device.public_url, device.created_at, device.last_seen_at)
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

export async function insertDeviceToken(db: D1Database, tokenHash: string, deviceId: string): Promise<void> {
  await db
    .prepare("INSERT INTO device_tokens (token_hash, device_id, created_at) VALUES (?, ?, ?)")
    .bind(tokenHash, deviceId, now())
    .run();
}

/** The live device and account behind a token hash, or null for anything revoked or unknown. */
export async function resolveDeviceToken(
  db: D1Database,
  tokenHash: string,
): Promise<{ device: Device; account: Account } | null> {
  const row = await db
    .prepare(
      `SELECT d.id AS d_id, d.account_id AS d_account_id, d.name AS d_name, d.profile AS d_profile,
              d.public_url AS d_public_url, d.created_at AS d_created_at, d.last_seen_at AS d_last_seen_at,
              d.revoked_at AS d_revoked_at, a.*
         FROM device_tokens t
         JOIN devices d ON d.id = t.device_id
         JOIN accounts a ON a.id = d.account_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<Record<string, string | null>>();
  if (!row) return null;
  const device: Device = {
    id: row.d_id as string,
    account_id: row.d_account_id as string,
    name: row.d_name as string,
    profile: row.d_profile as string,
    public_url: row.d_public_url as string,
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
