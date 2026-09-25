import type { Member, Role, Workspace } from "../team";
import { listAccountsWithUsage } from "./accounts";
import type { User } from "./auth";
import { db, ensureSchema } from "./db";
import { listDevices } from "./devices";
import { RequestError } from "./request-error";
import { purgeExpired } from "./retention";
import { listRuns } from "./runs";
import { listInvites, roleIn } from "./teams";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

/**
 * Everything the team page shows for `scope`: a team's id, or "me" for the
 * personal workspace. Computers, accounts and sessions come only for the
 * people the viewer may see them for: themselves, or everyone when they own
 * or administer the team.
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
  const [devices, accounts, invites] = await Promise.all([listDevices(detailed), listAccountsWithUsage(detailed), team && seesAll ? listInvites(team.id) : []]);
  const runs = await listRuns(devices.map((d) => d.id), viewer.id, team?.id ?? null);
  const members: Member[] = people.map((p) => ({
    ...p,
    detailed: detailed.includes(p.id),
    devices: devices.filter((d) => d.userId === p.id),
    accounts: accounts.filter((a) => a.userId === p.id),
  }));
  return { team, role, me: { id: viewer.id, email: viewer.email }, members, invites, runs, now: Date.now() };
}
