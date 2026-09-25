import { db, ensureSchema } from "./db";
import { readCookie, SESSION_COOKIE } from "./cookies";
import { hashPassword, newId, randomToken, sha256, verifyPassword } from "./crypto";
import { RequestError } from "./request-error";
import { leaveAllTeamsStatements } from "./teams";

export type User = { id: string; email: string };

const SESSION_TTL_MS = 30 * 86400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254) throw new RequestError(400, "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 8) throw new RequestError(400, "Password must be at least 8 characters.");
  if (password.length > 200) throw new RequestError(400, "Password is too long.");
  return { email: email.trim().toLowerCase(), password };
}

export async function register(email: string, password: string): Promise<User> {
  await ensureSchema();
  const existing = await db().execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  if (existing.rows.length) throw new RequestError(409, "An account with that email already exists. Sign in instead.");
  const id = newId();
  await db().execute({
    sql: "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    args: [id, email, hashPassword(password), Date.now()],
  });
  return { id, email };
}

export async function login(email: string, password: string): Promise<User> {
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT id, email, password_hash FROM users WHERE email = ?", args: [email] });
  const row = res.rows[0];
  // Verify against a dummy hash when the user is unknown so timing does not reveal existence.
  const hash = row ? String(row.password_hash) : DUMMY_HASH;
  const ok = verifyPassword(password, hash);
  if (!row || !ok) throw new RequestError(401, "Wrong email or password.");
  return { id: String(row.id), email: String(row.email) };
}

const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export async function createSession(userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await db().execute({
    sql: "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    args: [sha256(token), userId, now + SESSION_TTL_MS, now],
  });
  return token;
}

export async function getSessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req);
  if (!token) return null;
  await ensureSchema();
  const res = await db().execute({
    sql: "SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?",
    args: [sha256(token)],
  });
  const row = res.rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await db().execute({ sql: "DELETE FROM sessions WHERE id_hash = ?", args: [sha256(token)] });
    return null;
  }
  return { id: String(row.id), email: String(row.email) };
}

export async function destroySession(req: Request): Promise<void> {
  const token = readCookie(req);
  if (!token) return;
  await ensureSchema();
  await db().execute({ sql: "DELETE FROM sessions WHERE id_hash = ?", args: [sha256(token)] });
}

function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8) throw new RequestError(400, "Password must be at least 8 characters.");
  if (password.length > 200) throw new RequestError(400, "Password is too long.");
  return password;
}

async function checkPassword(userId: string, password: unknown): Promise<void> {
  const res = await db().execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [userId] });
  const row = res.rows[0];
  if (!row || typeof password !== "string" || !verifyPassword(password, String(row.password_hash))) throw new RequestError(401, "Wrong password.");
}

/**
 * Connected computers hold tokens of their own, so signing out everywhere
 * disconnects them too. Their history stays, and each one reconnects when its
 * owner signs in on it again.
 */
const disconnectComputers = (userId: string) => ({ sql: "UPDATE devices SET token_hash = NULL WHERE user_id = ?", args: [userId] });

/** Sets a new password and signs out every other device, computers included; the session behind `req` stays. */
export async function changePassword(req: Request, user: User, currentPassword: unknown, newPassword: unknown): Promise<void> {
  const next = validatePassword(newPassword);
  await checkPassword(user.id, currentPassword);
  if (currentPassword === next) throw new RequestError(400, "That is already your password.");
  const keep = readCookie(req);
  await db().batch(
    [
      { sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hashPassword(next), user.id] },
      { sql: "DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", args: [user.id, keep ? sha256(keep) : ""] },
      disconnectComputers(user.id),
    ],
    "write",
  );
}

/** Signs out every device except the one behind `req`, and disconnects every computer. Returns how many sessions went. */
export async function signOutOthers(req: Request, user: User): Promise<number> {
  const keep = readCookie(req);
  const [res] = await db().batch(
    [{ sql: "DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", args: [user.id, keep ? sha256(keep) : ""] }, disconnectComputers(user.id)],
    "write",
  );
  return res.rowsAffected;
}

/**
 * Deletes the user with every session, linked account and connected computer
 * (with the remote sessions and transcripts from them), and takes them out of their teams: a team
 * they own passes to someone else in it. Needs the password again.
 */
export async function deleteAccount(user: User, password: unknown): Promise<void> {
  await checkPassword(user.id, password);
  // Explicit, rather than relying on ON DELETE CASCADE being enforced by the server.
  await db().batch(
    [
      ...(await leaveAllTeamsStatements(user.id)),
      { sql: "DELETE FROM account_usage WHERE account_id IN (SELECT id FROM linked_accounts WHERE user_id = ?)", args: [user.id] },
      { sql: "DELETE FROM linked_accounts WHERE user_id = ?", args: [user.id] },
      { sql: "DELETE FROM run_events WHERE run_id IN (SELECT r.id FROM runs r JOIN devices d ON d.id = r.device_id WHERE d.user_id = ?)", args: [user.id] },
      { sql: "DELETE FROM runs WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)", args: [user.id] },
      { sql: "DELETE FROM session_transcripts WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)", args: [user.id] },
      { sql: "DELETE FROM devices WHERE user_id = ?", args: [user.id] },
      { sql: "DELETE FROM team_invites WHERE created_by = ?", args: [user.id] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [user.id] },
      { sql: "DELETE FROM users WHERE id = ?", args: [user.id] },
    ],
    "write",
  );
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Rejects cross-site form posts. SameSite=Lax cookies already block most; this closes the rest. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches without Origin (older UAs) or non-browser clients
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* Best-effort per-IP throttle for credential endpoints (per server instance). */
const attempts = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 20;
const WINDOW_MS = 15 * 60_000;

export function throttle(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LIMIT;
}
