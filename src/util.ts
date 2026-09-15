/** Small helpers shared across the Worker: ids, hashing, time, codes. */

const B64URL = /[+/=]/g;

export function now(): string {
  return new Date().toISOString();
}

export function plusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export function toBase64Url(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(B64URL, (ch) => (ch === "+" ? "-" : ch === "/" ? "_" : ""));
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Plain base64, for bodies carried inside JSON frames. Chunked: apply() has an argument limit. */
export function toBase64(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 8192)));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Device tokens carry a prefix so one can be recognized in a log or a file. */
export const DEVICE_TOKEN_PREFIX = "syd_";

export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomId(32);
}

// No 0, O, 1, or I: the code is read off one screen and typed into another.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A user code like WXYZ-2345, meant to be typed by a person. */
export function newUserCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return chars.slice(0, 4).join("") + "-" + chars.slice(4).join("");
}

/** What a person typed, normalized to the stored form; "" if it cannot be one. */
export function normalizeUserCode(raw: string): string {
  const letters = raw.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (letters.length !== 8) return "";
  return letters.slice(0, 4) + "-" + letters.slice(4);
}

/** Where a device's panel is published on this service: /p/<device>/. */
export const PANEL_PREFIX = "/p/";

export function panelUrl(publicUrl: string, deviceId: string): string {
  return publicUrl.replace(/\/$/, "") + PANEL_PREFIX + deviceId + "/";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}
