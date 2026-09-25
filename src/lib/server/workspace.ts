import { SHARE_NOTHING, type Member, type Role, type SharePolicy, type Workspace } from "../team";
import { listAccountsWithUsage } from "./accounts";
import { recentCommands } from "./commands";
import type { User } from "./auth";
import { db, ensureSchema } from "./db";
import { listDevices } from "./devices";
import { RequestError } from "./request-error";
import { purgeExpired } from "./retention";
import { listRuns } from "./runs";
import { managedBy, policiesOf, SHARE_ALL, showsWork } from "./sharing";
import { listInvites, roleIn } from "./teams";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

/**
 * Everything the team page shows for `scope`: a team's id, or "me" for the
 * personal workspace. Computers, accounts and sessions come only for the
 * people the viewer may see them for: themselves, or everyone when they own
 * or administer the team, and of those all the work of its members and what
 * its other owners and admins share (see sharing.ts).
 */
export async function workspace(viewer: User, scope: string): Promise<Workspace> {
  await ensureSchema();
  await purgeExpired();
  let team: Workspace["team"] = null;
  let role: Role | null = null;
  let people: { id: string; email: string; role: Role | null; joinedAt: number | null }[];
  if (scope === "me") {
    people = [{ id: viewer.id, email: viewer.email, role: null, joinedAt: null }];
  } else {
    role = await roleIn(scope, viewer.id);
    if (!role) throw new RequestError(404, "Team not found.");
    const [t, m] = await Promise.all([
      db().execute({ sql: "SELECT id, name FROM teams WHERE id = ?", args: [scope] }),
      db().execute({ sql: "SELECT u.id, u.email, m.role, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?", args: [scope] }),
    ]);
    team = { id: String(t.rows[0].id), name: String(t.rows[0].name) };
    people = m.rows
      .map((r) => ({ id: String(r.id), email: String(r.email), role: String(r.role) as Role, joinedAt: Number(r.joined_at) }))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joinedAt - b.joinedAt);
  }
  const seesAll = role === "owner" || role === "admin";
  const detailed = people.filter((p) => seesAll || p.id === viewer.id).map((p) => p.id);
  const [managed, policies] = await Promise.all([seesAll ? managedBy(viewer.id) : new Set<string>(), policiesOf(detailed)]);
  const grants = new Map<string, SharePolicy>(detailed.map((id) => [id, id === viewer.id || managed.has(id) ? SHARE_ALL : (policies.get(id) ?? SHARE_NOTHING)]));
  const [devices, accounts, invites] = await Promise.all([listDevices(detailed, viewer.id, grants), listAccountsWithUsage(detailed), team && seesAll ? listInvites(team.id) : []]);
  const [runs, commands] = await Promise.all([
    listRuns(devices.map((d) => d.id), viewer.id, team?.id ?? null),
    recentCommands(devices.filter((d) => d.userId === viewer.id).map((d) => d.id)),
  ]);
  for (const d of devices) d.commands = commands.get(d.id) ?? [];
  const byId = new Map(devices.map((d) => [d.id, d]));
  // A run shows with what it worked on: a project or chat its computer's owner shares with the viewer.
  const shownRuns = runs.filter((r) => {
    const d = byId.get(r.deviceId);
    return d !== undefined && showsWork(grants.get(d.userId) ?? SHARE_NOTHING, d, r.tool, r.project, [r.sessionId, r.resume]);
  });
  const members: Member[] = people.map((p) => ({
    ...p,
    detailed: detailed.includes(p.id),
    sharing: !team || !detailed.includes(p.id) ? null : p.role === "member" ? "managed" : policies.get(p.id)?.all ? "all" : "picked",
    devices: devices.filter((d) => d.userId === p.id),
    accounts: accounts.filter((a) => a.userId === p.id),
  }));
  const sharing = policies.get(viewer.id) ?? SHARE_NOTHING;
  return { team, role, me: { id: viewer.id, email: viewer.email }, members, invites, runs: shownRuns, sharing, now: Date.now() };
}
