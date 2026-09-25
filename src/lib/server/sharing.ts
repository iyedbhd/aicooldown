import type { DeviceActivity, Tool } from "../activity";
import { projectName, projectShared, SESSION_ID, sessionKey, sessionShared, SHARE_NOTHING, type DeviceSharing, type SharePolicy } from "../team";
import type { User } from "./auth";
import { openJson, sealJson } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { RequestError } from "./request-error";

/*
 * What people show of their work to the owners and admins of their teams. A
 * member shows everything: whoever runs a team they are a member of sees all
 * of their computers' projects and sessions, and what those sessions say where
 * the computer lets that reach the website. An owner or admin shows the other
 * owners and admins what they share: everything, or the projects and chats
 * they pick, and nothing else of theirs reaches them, not even that it exists.
 * Kept per person, encrypted like the rest of what computers report.
 */

const MAX_PROJECTS = 500;
const MAX_SESSIONS = 2_000;
const MAX_NAME = 200;
/** A session as SharePolicy names it: sessionKey, a computer's id, its CLI and the session's id. */
const SESSION_KEY = /^([\w-]{1,64}):(claude|codex):([0-9a-f-]{36})$/i;

/** All of it: someone's own work, and a member's for whoever runs their team. */
export const SHARE_ALL: SharePolicy = { all: true, projects: [], sessions: [] };

const strings = (v: unknown, max: number, ok: (s: string) => boolean) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ok(x)).slice(0, max) : []);
const projectOk = (name: string) => name.length > 0 && name.length <= MAX_NAME;

function parsePolicy(raw: unknown): SharePolicy {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { all: v.all === true, projects: strings(v.projects, MAX_PROJECTS, projectOk), sessions: strings(v.sessions, MAX_SESSIONS, (k) => SESSION_KEY.test(k)) };
}

/** What each of these people shares; someone who never chose shares nothing. */
export async function policiesOf(userIds: string[]): Promise<Map<string, SharePolicy>> {
  if (userIds.length === 0) return new Map();
  await ensureSchema();
  const res = await db().execute({ sql: `SELECT user_id, policy FROM sharing WHERE user_id IN (${placeholders(userIds.length)})`, args: userIds });
  return new Map(res.rows.map((r) => [String(r.user_id), parsePolicy(openJson(String(r.policy)))]));
}

export const policyOf = async (userId: string): Promise<SharePolicy> => (await policiesOf([userId])).get(userId) ?? SHARE_NOTHING;

/** The people who are members of a team `viewerId` owns or administers: `viewerId` sees all of their work. */
export async function managedBy(viewerId: string): Promise<Set<string>> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT DISTINCT b.user_id FROM team_members a JOIN team_members b ON a.team_id = b.team_id
      WHERE a.user_id = ? AND a.role IN ('owner', 'admin') AND b.role = 'member'`,
    args: [viewerId],
  });
  return new Set(res.rows.map((r) => String(r.user_id)));
}

/**
 * What of `ownerId`'s work `viewerId` sees: all of it (their own, or a
 * member's of a team they run), what the owner shares (an owner or admin of a
 * team they run too), or null for nothing.
 */
export async function accessTo(viewerId: string, ownerId: string): Promise<SharePolicy | null> {
  if (viewerId === ownerId) return SHARE_ALL;
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT MAX(b.role = 'member') AS managed FROM team_members a JOIN team_members b ON a.team_id = b.team_id
      WHERE a.user_id = ? AND a.role IN ('owner', 'admin') AND b.user_id = ?`,
    args: [viewerId, ownerId],
  });
  const managed = res.rows[0]?.managed;
  if (managed === null || managed === undefined) return null;
  return Number(managed) === 1 ? SHARE_ALL : policyOf(ownerId);
}

/** The part of a computer's activity `grant` shows: all of it, or the shared projects and sessions. */
export function visibleActivity(activity: DeviceActivity, grant: SharePolicy, deviceId: string): DeviceActivity {
  if (grant.all) return activity;
  return {
    ...activity,
    projects: activity.projects.filter((p) => projectShared(grant, p.name)),
    sessions: activity.sessions.filter((s) => sessionShared(grant, sessionKey(deviceId, s.tool, s.id), projectName(activity, s.tool, s.path))),
  };
}

type Place = { id: string; activity: DeviceActivity | null };

/** Whether `grant` shows this session of the computer's: shared by itself or with its project. */
export function showsSession(grant: SharePolicy, device: Place, tool: Tool, id: string): boolean {
  if (grant.all) return true;
  const session = device.activity?.sessions.find((s) => s.tool === tool && s.id === id);
  return grant.sessions.includes(sessionKey(device.id, tool, id)) || (session !== undefined && projectShared(grant, projectName(device.activity, tool, session.path)));
}

/**
 * Whether `grant` lets someone work in `project` on the computer (a remote
 * session there, one of its runs), continuing session `sessions` when given:
 * a shared project, or a shared chat.
 */
export function showsWork(grant: SharePolicy, device: Place, tool: Tool, project: string, sessions: (string | null)[] = []): boolean {
  if (grant.all || projectShared(grant, projectName(device.activity, tool, project))) return true;
  return sessions.some((id) => id !== null && grant.sessions.includes(sessionKey(device.id, tool, id)));
}

/**
 * Shares everything or only what is picked (`{ all }`), or shares or stops
 * sharing a project by name (`{ project, shared }`) or one of the user's own
 * sessions (`{ session: sessionKey, shared }`).
 */
export async function changeSharing(user: User, raw: Record<string, unknown>): Promise<SharePolicy> {
  let change: (p: SharePolicy) => SharePolicy;
  const shared = raw.shared === true;
  const toggle = (list: string[], item: string) => (shared ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item));
  if (typeof raw.all === "boolean") {
    const all = raw.all;
    change = (p) => ({ ...p, all });
  } else if (typeof raw.project === "string") {
    const name = raw.project;
    if (!projectOk(name)) throw new RequestError(400, "Which project?");
    change = (p) => ({ ...p, projects: toggle(p.projects, name) });
  } else if (typeof raw.session === "string") {
    const key = raw.session;
    const deviceId = SESSION_KEY.exec(key)?.[1];
    if (!deviceId || !SESSION_ID.test(key.slice(key.lastIndexOf(":") + 1))) throw new RequestError(400, "Which session?");
    await ensureSchema();
    const own = await db().execute({ sql: "SELECT 1 FROM devices WHERE id = ? AND user_id = ?", args: [deviceId, user.id] });
    if (own.rows.length === 0) throw new RequestError(404, "Computer not found.");
    change = (p) => ({ ...p, sessions: toggle(p.sessions, key) });
  } else {
    throw new RequestError(400, "What should be shared?");
  }
  await ensureSchema();
  // Read, change, write back only if nobody wrote in between (another tab, say); a few tries.
  for (let i = 0; i < 5; i++) {
    const row = (await db().execute({ sql: "SELECT policy FROM sharing WHERE user_id = ?", args: [user.id] })).rows[0];
    const stored = row ? String(row.policy) : null;
    const next = change(stored ? parsePolicy(openJson(stored)) : SHARE_NOTHING);
    if (next.projects.length > MAX_PROJECTS || next.sessions.length > MAX_SESSIONS) throw new RequestError(400, "That is as many projects and chats as can be shared one by one. Share everything instead.");
    const sealed = sealJson(next);
    const now = Date.now();
    const res = stored
      ? await db().execute({ sql: "UPDATE sharing SET policy = ?, updated_at = ? WHERE user_id = ? AND policy = ?", args: [sealed, now, user.id, stored] })
      : await db().execute({ sql: "INSERT INTO sharing (user_id, policy, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING", args: [user.id, sealed, now] });
    if (res.rowsAffected === 1) return next;
  }
  throw new RequestError(409, "Your sharing was changed somewhere else at the same time. Try again.");
}

/** A removed computer's sessions are not shared any more. */
export async function forgetDevice(userId: string, deviceId: string): Promise<void> {
  const policy = await policyOf(userId);
  const prefix = `${deviceId}:`;
  if (!policy.sessions.some((k) => k.startsWith(prefix))) return;
  await db().execute({
    sql: "UPDATE sharing SET policy = ?, updated_at = ? WHERE user_id = ?",
    args: [sealJson({ ...policy, sessions: policy.sessions.filter((k) => !k.startsWith(prefix)) }), Date.now(), userId],
  });
}

/** What a computer hears at each check-in: who else sees what of it (see DeviceSharing). */
export async function deviceSharing(ownerId: string, deviceId: string): Promise<DeviceSharing> {
  const [teams, policy] = await Promise.all([
    db().execute({ sql: "SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.role = 'member' ORDER BY t.name", args: [ownerId] }),
    policyOf(ownerId),
  ]);
  const prefix = `${deviceId}:`;
  return {
    managedBy: teams.rows.map((r) => String(r.name)),
    all: policy.all,
    projects: policy.projects,
    sessions: policy.sessions.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
  };
}
