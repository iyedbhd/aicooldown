import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { remoteDatabase } from "./db";

/*
 * Passwords: scrypt with a per-user salt. Provider tokens, and whatever else a
 * database dump should not show: AES-256-GCM under a key derived from
 * APP_SECRET, so a copy of the database alone does not expose them.
 */

const DEV_SECRET = "dev-only-secret-change-me";
let warned = false;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 16) return s;
  // The development key is in this file for all to read: fine for a database on this computer, never for a server's.
  if (process.env.NODE_ENV === "production" || remoteDatabase()) {
    throw new Error("APP_SECRET is not set. Set a long random string (32+ characters) in the environment.");
  }
  if (!warned) {
    warned = true;
    console.warn("[aicooldown] APP_SECRET not set: using a development key. Do not run like this in production.");
  }
  return DEV_SECRET;
}

function key(): Buffer {
  return createHash("sha256").update(secret()).digest();
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomToken(12);
}

/** One of OWASP's scrypt settings: 16 MiB, parallelism 5. */
const SCRYPT = { N: 16384, r: 8, p: 5 };
const KEYLEN = 64;

const derive = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

/** `scrypt$N$r$p$salt$hash`. Hashing runs off the main thread, so a sign-in does not hold up other requests. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** The settings a stored hash was made with; hashes from before carry only N (with r 8 and p 1). */
function settings(stored: string): { options: ScryptOptions; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return null;
  const [n, r, p, salt, hash] = parts.length === 6 ? parts.slice(1) : parts.length === 4 ? [parts[1], "8", "1", parts[2], parts[3]] : [];
  if (!salt || !hash) return null;
  return { options: { N: Number(n), r: Number(r), p: Number(p) }, salt: Buffer.from(salt, "base64"), hash: Buffer.from(hash, "base64") };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const s = settings(stored);
  if (!s) return false;
  const actual = await derive(password, s.salt, s.hash.length, s.options);
  return actual.length === s.hash.length && timingSafeEqual(actual, s.hash);
}

/** Whether a hash was made with weaker settings than today's, to hash the password again at its next sign-in. */
export function outdatedHash(stored: string): boolean {
  const s = settings(stored);
  return !s || s.options.N !== SCRYPT.N || s.options.r !== SCRYPT.r || s.options.p !== SCRYPT.p;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt(payload: string): string {
  if (!payload.startsWith("v1:")) throw new Error("Unknown ciphertext format");
  const buf = Buffer.from(payload.slice(3), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** A value kept as encrypted JSON. */
export const sealJson = (value: unknown) => encrypt(JSON.stringify(value));

/** A value kept by sealJson, or as plain JSON by a version from before it. */
export const openJson = <T>(stored: string): T => JSON.parse(stored.startsWith("v1:") ? decrypt(stored) : stored) as T;
