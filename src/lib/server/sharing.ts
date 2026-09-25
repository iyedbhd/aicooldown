import type { DeviceActivity, Tool } from "../activity";
import {
  ADMINS,
  projectName,
  projectShared,
  SESSION_ID,
  sessionKey,
  sessionShared,
  SHARE_NOTHING,
  teamAudience,
  userAudience,
  type Audience,
  type DeviceSharing,
  type Grant,
  type SharePolicy,
} from "../team";
import type { User } from "./auth";
import { openJson, sealJson } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { RequestError } from "./request-error";

/*
 * What people show of their work to the people in their teams. A member's
 * owners and admins see all of it: whoever runs a team they are a member of
 * sees every project and session on their computers, and what those sessions
 * say where the computer lets that reach the website. Beyond that, everyone
 * sees of someone else only what that person shares with them: a project (by
 * folder name, on all their computers) or a single chat, with the owners and
 * admins of their teams, with everyone in one of their teams, or with people
 * they pick; and an owner or admin may show the other owners and admins
 * everything. What is not shared does not reach anyone, not even that it
 * exists. Kept per person, encrypted like the rest of what computers report.
 */

const MAX_PROJECTS = 500;
const MAX_SESSIONS = 2_000;
const MAX_AUDIENCES = 50;
const MAX_NAME = 200;
/** A session as SharePolicy names it: sessionKey, a computer's id, its CLI and the session's id. */
const SESSION_KEY = /^([\w-]{1,64}):(claude|codex):([0-9a-f-]{36})$/i;
const AUDIENCE = /^(admins|team:[\w-]{1,64}|user:[\w-]{1,64})$/;

/** All of it: someone's own work, and a member's for whoever runs their team. */
export const GRANT_ALL: Grant = { all: true, projects: [], sessions: [] };

const projectOk = (name: string) => name.length > 0 && name.length <= MAX_NAME;
const sessionOk = (key: string) => SESSION_KEY.test(key) && SESSION_ID.test(key.slice(key.lastIndexOf(":") + 1));

/** Shared items with their audiences; 0.7 kept a list, each item shared with the owners and admins. */
function items(raw: unknown, max: number, ok: (key: string) => boolean): Record<string, Audience[]> {
  const out: Record<string, Audience[]> = {};
  const entries: [unknown, unknown][] = Array.isArray(raw) ? raw.map((k) => [k, [ADMINS]]) : raw && typeof raw === "object" ? Object.entries(raw) : [];
  for (const [key, list] of entries) {
    if (typeof key !== "string" || !ok(key) || Object.keys(out).length >= max) continue;
    const audiences = Array.isArray(list) ? [...new Set(list.filter((a): a is string => typeof a === "string" && AUDIENCE.test(a)))].slice(0, MAX_AUDIENCES) : [];
    if (audiences.length) out[key] = audiences;
  }
  return out;
}

function parsePolicy(raw: unknown): SharePolicy {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { all: v.all === true, projects: items(v.projects, MAX_PROJECTS, projectOk), sessions: items(v.sessions, MAX_SESSIONS, sessionOk) };
}

/** What each of these people shares; someone who never chose shares nothing. */
export async function policiesOf(userIds: string[]): Promise<Map<string, SharePolicy>> {
  if (userIds.length === 0) return new Map();
  await ensureSchema();
  const res = await db().execute({ sql: `SELECT user_id, policy FROM sharing WHERE user_id IN (${placeholders(userIds.length)})`, args: userIds });
  return new Map(res.rows.map((r) => [String(r.user_id), parsePolicy(openJson(String(r.policy)))]));
}

export const policyOf = async (userId: string): Promise<SharePolicy> => (await policiesOf([userId])).get(userId) ?? SHARE_NOTHING;

/**
 * How someone is in teams with the viewer: the teams they are both in,
 * whether the viewer owns or administers one of those, and whether one of
 * those has them as a member under the viewer (then the viewer sees all of
 * their work).
 */
export type Relation = { teams: string[]; admin: boolean; managed: boolean };

/** The viewer's relation to everyone they are in a team with, or to `only` of them. */
export async function relations(viewerId: string, only?: string): Promise<Map<string, Relation>> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT b.user_id, a.team_id, a.role AS mine, b.role AS theirs FROM team_members a JOIN team_members b ON a.team_id = b.team_id
      WHERE a.user_id = ? AND b.user_id != a.user_id${only ? " AND b.user_id = ?" : ""}`,
    args: only ? [viewerId, only] : [viewerId],
  });
  const out = new Map<string, Relation>();
  for (const r of res.rows) {
    const id = String(r.user_id);
    const rel = out.get(id) ?? { teams: [], admin: false, managed: false };
    const runs = r.mine === "owner" || r.mine === "admin";
    rel.teams.push(String(r.team_id));
    rel.admin ||= runs;
    rel.managed ||= runs && r.theirs === "member";
    out.set(id, rel);
  }
  return out;
}

/** What `viewerId`, related to them as `rel`, sees of someone's work shared as `policy`. */
export function grantFor(policy: SharePolicy, viewerId: string, rel: Relation): Grant {
  if (rel.managed) return GRANT_ALL;
  const reaching = new Set<Audience>([userAudience(viewerId), ...rel.teams.map(teamAudience), ...(rel.admin ? [ADMINS] : [])]);
  const reaches = ([, audiences]: [string, Audience[]]) => audiences.some((a) => reaching.has(a));
  return {
    all: policy.all && rel.admin,
    projects: Object.entries(policy.projects).filter(reaches).map(([name]) => name),
    sessions: Object.entries(policy.sessions).filter(reaches).map(([key]) => key),
  };
}

/** Whether a grant shows anything at all. */
export const grantsAny = (grant: Grant) => grant.all || grant.projects.length > 0 || grant.sessions.length > 0;

/**
 * What of `ownerId`'s work `viewerId` sees: all of it (their own, or a
 * member's of a team they run), what the owner shares with them (someone in
 * a team with them), or null for nothing.
 */
export async function accessTo(viewerId: string, ownerId: string): Promise<Grant | null> {
  if (viewerId === ownerId) return GRANT_ALL;
  const rel = (await relations(viewerId, ownerId)).get(ownerId);
  if (!rel) return null;
  return rel.managed ? GRANT_ALL : grantFor(await policyOf(ownerId), viewerId, rel);
}

/** The part of a computer's activity `grant` shows: all of it, or the shared projects and sessions. */
export function visibleActivity(activity: DeviceActivity, grant: Grant, deviceId: string): DeviceActivity {
  if (grant.all) return activity;
  return {
    ...activity,
    projects: activity.projects.filter((p) => projectShared(grant, p.name)),
    sessions: activity.sessions.filter((s) => sessionShared(grant, sessionKey(deviceId, s.tool, s.id), projectName(activity, s.tool, s.path))),
  };
}

type Place = { id: string; activity: DeviceActivity | null };

/** Whether `grant` shows this session of the computer's: shared by itself or with its project. */
export function showsSession(grant: Grant, device: Place, tool: Tool, id: string): boolean {
  if (grant.all) return true;
  const session = device.activity?.sessions.find((s) => s.tool === tool && s.id === id);
  return grant.sessions.includes(sessionKey(device.id, tool, id)) || (session !== undefined && projectShared(grant, projectName(device.activity, tool, session.path)));
}

/**
 * Whether `grant` lets someone work in `project` on the computer (a remote
 * session there, one of its runs), continuing session `sessions` when given:
 * a shared project, or a shared chat.
 */
export function showsWork(grant: Grant, device: Place, tool: Tool, project: string, sessions: (string | null)[] = []): boolean {
  if (grant.all || projectShared(grant, projectName(device.activity, tool, project))) return true;
  return sessions.some((id) => id !== null && grant.sessions.includes(sessionKey(device.id, tool, id)));
}

/** An audience the user may share with: the owners and admins of their teams, one of their teams, or someone in one of them. */
async function audienceOk(userId: string, audience: string): Promise<boolean> {
  if (audience === ADMINS) return true;
  const [kind, id] = audience.split(":");
  const res = await db().execute(
    kind === "team"
      ? { sql: "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?", args: [id, userId] }
      : { sql: "SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.user_id = ? AND b.user_id = ? AND b.user_id != a.user_id LIMIT 1", args: [userId, id] },
  );
  return res.rows.length > 0;
}

/**
 * Shares everything with the owners and admins of the user's teams, or only
 * what is picked (`{ all }`); or shares a project by name (`{ project }`) or
 * one of the user's own sessions (`{ session: sessionKey }`) with an audience
 * (`audience`, see Audience; the owners and admins when none is given), or
 * stops (`shared: false`).
 */
export async function changeSharing(user: User, raw: Record<string, unknown>): Promise<SharePolicy> {
  let change: (p: SharePolicy) => SharePolicy;
  await ensureSchema();
  if (typeof raw.all === "boolean") {
    const all = raw.all;
    change = (p) => ({ ...p, all });
  } else {
    const audience = raw.audience ?? ADMINS;
    if (typeof audience !== "string" || !AUDIENCE.test(audience) || !(await audienceOk(user.id, audience))) throw new RequestError(400, "Share it with whom? Only with people in a team with you.");
    const shared = raw.shared === true;
    const toggle = (map: Record<string, Audience[]>, key: string) => {
      const next = { ...map };
      const audiences = (map[key] ?? []).filter((a) => a !== audience);
      if (shared) audiences.push(audience);
      if (audiences.length) next[key] = audiences.slice(-MAX_AUDIENCES);
      else delete next[key];
      return next;
    };
    if (typeof raw.project === "string") {
      const name = raw.project;
      if (!projectOk(name)) throw new RequestError(400, "Which project?");
      change = (p) => ({ ...p, projects: toggle(p.projects, name) });
    } else if (typeof raw.session === "string") {
      const key = raw.session;
      if (!sessionOk(key)) throw new RequestError(400, "Which session?");
      const own = await db().execute({ sql: "SELECT 1 FROM devices WHERE id = ? AND user_id = ?", args: [SESSION_KEY.exec(key)![1], user.id] });
      if (own.rows.length === 0) throw new RequestError(404, "Computer not found.");
      change = (p) => ({ ...p, sessions: toggle(p.sessions, key) });
    } else {
      throw new RequestError(400, "What should be shared?");
    }
  }
  // Read, change, write back only if nobody wrote in between (another tab, say); a few tries.
  for (let i = 0; i < 5; i++) {
    const row = (await db().execute({ sql: "SELECT policy FROM sharing WHERE user_id = ?", args: [user.id] })).rows[0];
    const stored = row ? String(row.policy) : null;
    const next = change(stored ? parsePolicy(openJson(stored)) : SHARE_NOTHING);
    if (Object.keys(next.projects).length > MAX_PROJECTS || Object.keys(next.sessions).length > MAX_SESSIONS) {
      throw new RequestError(400, "That is as many projects and chats as can be shared one by one.");
    }
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
  const gone = Object.keys(policy.sessions).filter((k) => k.startsWith(prefix));
  if (gone.length === 0) return;
  const sessions = { ...policy.sessions };
  for (const k of gone) delete sessions[k];
  await db().execute({ sql: "UPDATE sharing SET policy = ?, updated_at = ? WHERE user_id = ?", args: [sealJson({ ...policy, sessions }), Date.now(), userId] });
}

/**
 * What a computer hears at each check-in (see DeviceSharing): whether its
 * owner is managed, and what they share with anyone, which is all it lets
 * anyone else's session work in (the server says who; this is what).
 */
export async function deviceSharing(ownerId: string, deviceId: string): Promise<DeviceSharing> {
  const [teams, policy] = await Promise.all([
    db().execute({ sql: "SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.role = 'member' ORDER BY t.name", args: [ownerId] }),
    policyOf(ownerId),
  ]);
  const prefix = `${deviceId}:`;
  return {
    managedBy: teams.rows.map((r) => String(r.name)),
    all: policy.all,
    projects: Object.keys(policy.projects),
    sessions: Object.keys(policy.sessions)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
  };
}

