import type { InStatement } from "@libsql/client";
import type { Invite, InvitePreview, Role, TeamSummary } from "../team";
import type { User } from "./auth";
import { newId, randomToken, sha256 } from "./crypto";
import { db, ensureSchema } from "./db";
import { RequestError } from "./request-error";

/*
 * Teams. The owner runs the team: renames or deletes it, changes roles, and
 * hands it to someone else. Admins invite people and remove members. Owners
 * and admins see all of every member's work (computers, projects, sessions and
 * what they say, token usage, account limits, remote sessions), of each other
 * the computers, limits and what each shares (sharing.ts), and may start
 * sessions on the computers they see when those allow it. Members see the
 * roster and their own details.
 */

const INVITE_TTL_MS = 7 * 86400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Row = Record<string, unknown>;

function teamName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new RequestError(400, "Give the team a name.");
  return trimmed.slice(0, 60);
}

export async function roleIn(teamId: string, userId: string): Promise<Role | null> {
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?", args: [teamId, userId] });
  return res.rows[0] ? (String(res.rows[0].role) as Role) : null;
}

/** The user's role in the team, which must be one of `allowed`. Not being in it at all reads as a missing team. */
async function requireRole(teamId: string, userId: string, allowed: Role[], action: string): Promise<Role> {
  const role = await roleIn(teamId, userId);
  if (!role) throw new RequestError(404, "Team not found.");
  if (!allowed.includes(role)) throw new RequestError(403, `Only the team's ${allowed.join(" or ")} can ${action}.`);
  return role;
}

/** Whether `viewerId` is an owner or admin of a team `userId` belongs to: who sees and acts on someone else's computers. */
export async function adminOver(viewerId: string, userId: string): Promise<boolean> {
  if (viewerId === userId) return true;
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
      WHERE a.user_id = ? AND a.role IN ('owner', 'admin') AND b.user_id = ? LIMIT 1`,
    args: [viewerId, userId],
  });
  return res.rows.length > 0;
}

/**
 * Whether `viewerId` may see a remote session that `creatorId` started on
 * `ownerId`'s computer: on their own computer, or as an owner or admin of a
 * team both the computer's owner and whoever started it are in. A session
 * started from one team stays out of the sight of another team the computer's
 * owner is also in.
 */
export async function seesRun(viewerId: string, ownerId: string, creatorId: string | null): Promise<boolean> {
  if (viewerId === ownerId) return true;
  if (!creatorId) return false;
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT 1 FROM team_members v JOIN team_members o ON o.team_id = v.team_id JOIN team_members c ON c.team_id = v.team_id
      WHERE v.user_id = ? AND v.role IN ('owner', 'admin') AND o.user_id = ? AND c.user_id = ? LIMIT 1`,
    args: [viewerId, ownerId, creatorId],
  });
  return res.rows.length > 0;
}

export async function listTeams(userId: string): Promise<TeamSummary[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT t.id, t.name, m.role, (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS members
      FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.created_at`,
    args: [userId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name), role: String(r.role) as Role, members: Number(r.members) }));
}

export async function createTeam(userId: string, name: unknown): Promise<TeamSummary> {
  const team = { id: newId(), name: teamName(name) };
  await ensureSchema();
  const now = Date.now();
  await db().batch(
    [
      { sql: "INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)", args: [team.id, team.name, now] },
      { sql: "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", args: [team.id, userId, now] },
    ],
    "write",
  );
  return { ...team, role: "owner", members: 1 };
}

export async function renameTeam(userId: string, teamId: string, name: unknown): Promise<void> {
  await requireRole(teamId, userId, ["owner", "admin"], "rename it");
  await db().execute({ sql: "UPDATE teams SET name = ? WHERE id = ?", args: [teamName(name), teamId] });
}

const deleteTeamStatements = (teamId: string): InStatement[] => [
  { sql: "DELETE FROM team_invites WHERE team_id = ?", args: [teamId] },
  { sql: "DELETE FROM team_members WHERE team_id = ?", args: [teamId] },
  { sql: "DELETE FROM teams WHERE id = ?", args: [teamId] },
];

/** Deletes the team. Its members keep their accounts, computers and sessions. */
export async function deleteTeam(userId: string, teamId: string): Promise<void> {
  await requireRole(teamId, userId, ["owner"], "delete it");
  await db().batch(deleteTeamStatements(teamId), "write");
}

/** Owner only. Making someone the owner hands the team over: the previous owner becomes an admin. */
export async function setRole(actorId: string, teamId: string, targetId: string, role: unknown): Promise<void> {
  await requireRole(teamId, actorId, ["owner"], "change roles");
  if (role !== "owner" && role !== "admin" && role !== "member") throw new RequestError(400, "Unknown role.");
  if (targetId === actorId) throw new RequestError(400, "You are the owner. Make someone else the owner to step down.");
  if (!(await roleIn(teamId, targetId))) throw new RequestError(404, "They are not in this team.");
  const update = (userId: string, r: Role): InStatement => ({ sql: "UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?", args: [r, teamId, userId] });
  await db().batch(
    role === "owner"
      ? [update(targetId, "owner"), update(actorId, "admin"), ...invitesBeyond(teamId, actorId, "admin")]
      : [update(targetId, role), ...invitesBeyond(teamId, targetId, role)],
    "write",
  );
}

/** The invites someone made that their role in the team no longer lets them give out: admins invite members, members nobody. */
function invitesBeyond(teamId: string, userId: string, role: Role): InStatement[] {
  if (role === "owner") return [];
  return [{ sql: `DELETE FROM team_invites WHERE team_id = ? AND created_by = ?${role === "admin" ? " AND role = 'admin'" : ""}`, args: [teamId, userId] }];
}

/** Removes someone, or leaves when it is yourself. Admins remove members; the owner removes anyone but hands the team over before leaving. */
export async function removeMember(actorId: string, teamId: string, targetId: string): Promise<void> {
  const actorRole = await requireRole(teamId, actorId, ["owner", "admin", "member"], "remove people");
  if (targetId === actorId) {
    if (actorRole === "owner") throw new RequestError(400, "Make someone else the owner first, or delete the team.");
  } else {
    const targetRole = await roleIn(teamId, targetId);
    if (!targetRole) throw new RequestError(404, "They are not in this team.");
    if (actorRole === "member" || targetRole === "owner" || (actorRole === "admin" && targetRole === "admin")) {
      throw new RequestError(403, actorRole === "member" ? "Only owners and admins remove people." : "Only the owner can remove an admin, and nobody can remove the owner.");
    }
  }
  await db().batch(
    [{ sql: "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", args: [teamId, targetId] }, ...invitesBeyond(teamId, targetId, "member")],
    "write",
  );
}

/**
 * What deleting a user's account does to their teams, as statements for the
 * same batch: their memberships go, and a team they own passes to its
 * longest-standing admin, else member, or is deleted when nobody is left.
 */
export async function leaveAllTeamsStatements(userId: string): Promise<InStatement[]> {
  await ensureSchema();
  const statements: InStatement[] = [];
  for (const team of await listTeams(userId)) {
    if (team.role === "owner") {
      const next = await db().execute({
        sql: `SELECT user_id FROM team_members WHERE team_id = ? AND user_id != ?
          ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
        args: [team.id, userId],
      });
      if (!next.rows[0]) {
        statements.push(...deleteTeamStatements(team.id));
        continue;
      }
      statements.push({ sql: "UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?", args: [team.id, String(next.rows[0].user_id)] });
    }
    statements.push({ sql: "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", args: [team.id, userId] });
  }
  return statements;
}

/**
 * An invite link, single use, valid for a week. With an email, only the
 * account with that email can accept it (AI Cooldown does not verify emails,
 * so the link is what has to stay private). The link holds the only copy of
 * its token; the server keeps its hash.
 */
export async function createInvite(actorId: string, teamId: string, email: unknown, role: unknown, origin: string): Promise<{ invite: Invite; url: string }> {
  const actorRole = await requireRole(teamId, actorId, ["owner", "admin"], "invite people");
  if (role !== "admin" && role !== "member") throw new RequestError(400, "Invite as an admin or a member.");
  if (role === "admin" && actorRole !== "owner") throw new RequestError(403, "Only the owner can invite admins.");
  let bound: string | null = null;
  if (typeof email === "string" && email.trim()) {
    bound = email.trim().toLowerCase();
    if (!EMAIL_RE.test(bound) || bound.length > 254) throw new RequestError(400, "Enter a valid email address, or leave it empty for a link anyone can use once.");
    const member = await db().execute({
      sql: "SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?",
      args: [teamId, bound],
    });
    if (member.rows.length) throw new RequestError(409, "They are already in this team.");
  }
  const token = randomToken(24);
  const now = Date.now();
  const invite: Invite = { id: newId(), email: bound, role, createdAt: now, expiresAt: now + INVITE_TTL_MS, by: null };
  await db().execute({
    sql: "INSERT INTO team_invites (id, team_id, token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [invite.id, teamId, sha256(token), bound, role, actorId, now, invite.expiresAt],
  });
  return { invite, url: `${origin}/join/${token}` };
}

export async function revokeInvite(actorId: string, teamId: string, inviteId: string): Promise<void> {
  await requireRole(teamId, actorId, ["owner", "admin"], "revoke invites");
  await db().execute({ sql: "DELETE FROM team_invites WHERE id = ? AND team_id = ?", args: [inviteId, teamId] });
}

export async function listInvites(teamId: string): Promise<Invite[]> {
  const res = await db().execute({
    sql: `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.email AS by_email FROM team_invites i
      LEFT JOIN users u ON u.id = i.created_by WHERE i.team_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`,
    args: [teamId, Date.now()],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    email: r.email === null ? null : String(r.email),
    role: String(r.role) as Role,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    by: r.by_email === null ? null : String(r.by_email),
  }));
}

async function findInvite(token: string): Promise<Row & InvitePreview> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT i.*, t.name AS team_name, u.email AS by_email FROM team_invites i JOIN teams t ON t.id = i.team_id
      LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?`,
    args: [sha256(token)],
  });
  const row = res.rows[0] as Row | undefined;
  if (!row) throw new RequestError(404, "This invite link does not work. It may have been used already or revoked.");
  if (Number(row.expires_at) < Date.now()) throw new RequestError(410, "This invite has expired. Ask for a new one.");
  return {
    ...row,
    team: String(row.team_name),
    role: String(row.role) as Role,
    email: row.email === null ? null : String(row.email),
    by: row.by_email === null ? null : String(row.by_email),
    expiresAt: Number(row.expires_at),
  };
}

export async function previewInvite(token: string): Promise<InvitePreview> {
  const { team, role, email, by, expiresAt } = await findInvite(token);
  return { team, role, email, by, expiresAt };
}

/**
 * Joins the team the invite is for, and uses the invite up. Returns the team's
 * id. Whoever made the invite must still be allowed to give it out: someone
 * removed from the team, or no longer an admin, cannot let anyone in with
 * links made before.
 */
export async function acceptInvite(user: User, token: string): Promise<string> {
  const invite = await findInvite(token);
  if (invite.email && invite.email !== user.email) throw new RequestError(403, `This invite is for ${invite.email}. Sign in with that account to accept it.`);
  const teamId = String(invite.team_id);
  const id = String(invite.id);
  const giver = await roleIn(teamId, String(invite.created_by));
  if (giver !== "owner" && !(giver === "admin" && invite.role === "member")) {
    await db().execute({ sql: "DELETE FROM team_invites WHERE id = ?", args: [id] });
    throw new RequestError(404, "This invite link does not work any more: whoever made it can no longer invite people.");
  }
  // One transaction: joining only while the invite still exists, then using it up. Of two people accepting at once, one gets in.
  const [, used] = await db().batch(
    [
      {
        sql: `INSERT INTO team_members (team_id, user_id, role, joined_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM team_invites WHERE id = ?)
          ON CONFLICT (team_id, user_id) DO NOTHING`,
        args: [teamId, user.id, invite.role, Date.now(), id],
      },
      { sql: "DELETE FROM team_invites WHERE id = ?", args: [id] },
    ],
    "write",
  );
  if (used.rowsAffected === 0) throw new RequestError(404, "This invite link does not work. It may have been used already or revoked.");
  return teamId;
}
