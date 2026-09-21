import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/*
 * Passwords: scrypt with a per-user salt. Provider tokens: AES-256-GCM under a
 * key derived from APP_SECRET, so a database dump alone does not expose them.
 */

const DEV_SECRET = "dev-only-secret-change-me";
let warned = false;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
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

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
