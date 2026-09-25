import { GRANT_NOTHING, SHARE_NOTHING, type Grant, type Member, type Role, type Workspace } from "../team";
import { listAccountsWithUsage } from "./accounts";
import { recentCommands } from "./commands";
import type { User } from "./auth";
import { db, ensureSchema } from "./db";
import { listDevices } from "./devices";
import { RequestError } from "./request-error";
import { purgeExpired } from "./retention";
import { listRuns } from "./runs";
import { GRANT_ALL, grantFor, grantsAny, policiesOf, relations, showsWork } from "./sharing";
import { listInvites, roleIn } from "./teams";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

/**
 * Everything the team page shows for `scope`: a team's id, or "me" for the
 * personal workspace. Computers, accounts and remote sessions come only for
 * the people the viewer may see them for: themselves, or everyone when they
 * own or administer the team (all of a member's work, what an owner or admin
 * shares; see sharing.ts). Of anyone else, only the projects and chats they
 * share with the viewer, on computers that show nothing more than their name.
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
  const [related, policies] = await Promise.all([team ? relations(viewer.id) : new Map(), policiesOf(people.map((p) => p.id))]);
  const grants = new Map<string, Grant>();
  for (const p of people) {
    const rel = related.get(p.id);
    grants.set(p.id, p.id === viewer.id ? GRANT_ALL : rel ? grantFor(policies.get(p.id) ?? SHARE_NOTHING, viewer.id, rel) : GRANT_NOTHING);
  }
  // The others' computers too, for what they share with the viewer.
  const withWork = people.filter((p) => detailed.includes(p.id) || grantsAny(grants.get(p.id)!)).map((p) => p.id);
  const [devices, accounts, invites] = await Promise.all([
    listDevices(withWork, viewer.id, grants, new Set(detailed)),
    listAccountsWithUsage(detailed),
    team && seesAll ? listInvites(team.id) : [],
  ]);
  const [runs, commands] = await Promise.all([
    listRuns(devices.filter((d) => detailed.includes(d.userId)).map((d) => d.id), viewer.id, team?.id ?? null),
    recentCommands(devices.filter((d) => d.userId === viewer.id).map((d) => d.id)),
  ]);
  for (const d of devices) d.commands = commands.get(d.id) ?? [];
  const byId = new Map(devices.map((d) => [d.id, d]));
  // A run shows with what it worked on: a project or chat its computer's owner shares with the viewer.
  const shownRuns = runs.filter((r) => {
    const d = byId.get(r.deviceId);
    return d !== undefined && showsWork(grants.get(d.userId) ?? GRANT_NOTHING, d, r.tool, r.project, [r.sessionId, r.resume]);
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
