/** AES-GCM under DRIVE_KEY, for the one secret we keep on behalf of a person. */

import { fromBase64Url, toBase64Url } from "./util";

async function key(secret: string): Promise<CryptoKey> {
  // Any string works as the secret; it is hashed to 256 bits first.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(text));
  return toBase64Url(iv) + "." + toBase64Url(new Uint8Array(box));
}

export async function decrypt(secret: string, sealed: string): Promise<string> {
  const [ivText, boxText] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivText) },
    await key(secret),
    fromBase64Url(boxText),
  );
  return new TextDecoder().decode(plain);
}
