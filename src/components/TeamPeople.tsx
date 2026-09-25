"use client";

import { useState } from "react";
import { formatTokens, lastDays } from "@/lib/activity";
import { formatAgo, formatCountdown, formatMoney, formatPlan } from "@/lib/format";
import { createInvite, manages, removeMember, revokeInvite, setRole, type Invite, type Member, type MemberAccount, type Role, type Workspace } from "@/lib/team";
import { fullestWindow, lastActive, projectsOf, rollupProjects, totalsSince, type Period, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { PROVIDER_META, ProviderGlyph } from "./ProviderLogo";
import { Avatar, Card, Empty, OnlineDot, RoleBadge } from "./TeamBits";
import { SessionLine, type SessionFilter } from "./TeamSessions";

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  period: Period;
  now: number;
  reload: () => Promise<void>;
  flash: (text: string) => void;
  onOpenSession: (key: string) => void;
  onShowSessions: (only: Partial<SessionFilter>) => void;
};

/** A person's latest sessions shown in their details. */
const RECENT_SESSIONS = 5;

const input = "rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";

/** Everyone in the workspace, what each of them uses, and (for owners and admins) inviting and managing people. */
export function TeamPeople({ ws, sessions, period, now, reload, flash, onOpenSession, onShowSessions }: Props) {
  const [open, setOpen] = useState<string | null>(ws.members.length === 1 ? ws.members[0].id : null);
  const since = lastDays(period, now)[0];

  return (
    <div className="space-y-6">
      {ws.team && manages(ws.role) && <InviteCard ws={ws} now={now} reload={reload} flash={flash} />}
      <Card title={ws.team ? `${ws.members.length} ${ws.members.length === 1 ? "person" : "people"}` : "You"}>
        <ul className="divide-y divide-line">
          {ws.members.map((m) => {
            const projects = projectsOf(m.devices);
            const totals = totalsSince(projects, since);
            const online = m.devices.filter((d) => d.online).length;
            const fullest = m.accounts
              .map((a) => ({ a, w: fullestWindow(a) }))
              .filter((x) => x.w)
              .sort((x, y) => y.w!.usedPercent - x.w!.usedPercent)[0];
            const active = lastActive(projects);
            const theirs = sessions.filter((s) => s.member.id === m.id);
            const live = theirs.filter((s) => s.active).length;
            const expanded = open === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : m.id)}
                  aria-expanded={expanded}
                  disabled={!m.detailed}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-panel-2 disabled:hover:bg-transparent"
                >
                  <span className="flex min-w-0 flex-1 basis-60 items-center gap-3">
                    <Avatar email={m.email} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{m.email}</span>
                        {m.role && <RoleBadge role={m.role} />}
                        {m.id === ws.me.id && <span className="text-[11px] text-faint">you</span>}
                        {live > 0 && (
                          <span className="chip chip-good">
                            <span className="live h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                            {live} live
                          </span>
                        )}
                      </span>
                      <span className="block font-mono text-[11px] text-muted">
                        {m.detailed
                          ? `${online}/${m.devices.length} computer${m.devices.length === 1 ? "" : "s"} online${active ? ` · active ${formatAgo(now - active)}` : ""}`
                          : m.joinedAt
                            ? `joined ${formatAgo(now - m.joinedAt)}`
                            : ""}
                      </span>
                    </span>
                  </span>
                  {m.detailed && (
                    <span className="flex shrink-0 items-center gap-5">
                      <Stat label={`tokens · ${period}d`} value={formatTokens(totals.tokens)} />
                      <Stat label="api value" value={totals.cost > 0 ? `≈ ${formatMoney(totals.cost)}` : "—"} />
                      <Stat
                        label="fullest limit"
                        value={fullest ? `${Math.round(fullest.w!.usedPercent)}%` : "—"}
                        tone={fullest && fullest.w!.usedPercent >= 90 ? "bad" : fullest && fullest.w!.usedPercent >= 70 ? "warn" : undefined}
                        title={fullest ? `${fullest.a.label} · ${fullest.w!.label}` : "No linked accounts"}
                      />
                      <Icon name="chevron" size={12} className={`text-faint transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </span>
                  )}
                </button>
                {expanded && (
                  <MemberDetail ws={ws} member={m} sessions={theirs} since={since} now={now} reload={reload} flash={flash} onOpenSession={onOpenSession} onShowSessions={onShowSessions} />
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: "warn" | "bad"; title?: string }) {
  const color = tone === "bad" ? "text-rose-600 dark:text-rose-300" : tone === "warn" ? "text-amber-600 dark:text-amber-300" : "text-fg";
  return (
    <span className="w-20 text-right" title={title}>
      <span className="block text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className={`block font-mono text-sm tabular-nums ${color}`}>{value}</span>
    </span>
  );
}

type DetailProps = Omit<Props, "period"> & { member: Member; since: string };

function MemberDetail({ ws, member, sessions, since, now, reload, flash, onOpenSession, onShowSessions }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const projects = rollupProjects([member], since).slice(0, 6);
  const isMe = member.id === ws.me.id;
  const canRemove = ws.team && !isMe && member.role !== "owner" && (ws.role === "owner" || (ws.role === "admin" && member.role === "member"));
  const canSetRole = ws.team && !isMe && ws.role === "owner";

  async function act(run: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusy(true);
    const res = await run();
    setBusy(false);
    if (!res.ok) return flash(res.error ?? "Something went wrong.");
    flash(done);
    await reload();
  }

  function changeRole(role: Role) {
    if (!ws.team) return;
    if (role === "owner" && !window.confirm(`Make ${member.email} the owner of ${ws.team.name}? You become an admin.`)) return;
    void act(() => setRole(ws.team!.id, member.id, role), role === "owner" ? `${member.email} owns the team now.` : `${member.email} is now ${role === "admin" ? "an admin" : "a member"}.`);
  }

  function remove() {
    if (!ws.team || !window.confirm(`Remove ${member.email} from ${ws.team.name}? Their computers and accounts stay theirs.`)) return;
    void act(() => removeMember(ws.team!.id, member.id), `Removed ${member.email}.`);
  }

  return (
    <div className="space-y-4 border-t border-line bg-panel-2/40 px-4 py-4">
      {member.detailed ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <p className="eyebrow mb-2">linked accounts</p>
            {member.accounts.length === 0 ? <p className="text-xs text-muted">None.</p> : member.accounts.map((a) => <AccountLimits key={a.id} account={a} now={now} />)}
          </div>
          <div>
            <p className="eyebrow mb-2">computers</p>
            {member.devices.length === 0 ? (
              <p className="text-xs text-muted">None connected.</p>
            ) : (
              <ul className="space-y-2">
                {member.devices.map((d) => (
                  <li key={d.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-sm text-fg">
                        <Icon name="monitor" size={13} className="shrink-0 text-faint" />
                        {d.name}
                      </span>
                      <OnlineDot online={d.online} lastSeenAt={d.lastSeenAt} now={now} />
                    </div>
                    {(["claude", "codex"] as const).map((p) => (
                      <p key={p} className="mt-1 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted">
                        <ProviderGlyph provider={p} size={11} />
                        {d.logins[p] ?? "not signed in"}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="eyebrow mb-2">projects</p>
            {projects.length === 0 ? (
              <p className="text-xs text-muted">No activity in this period.</p>
            ) : (
              <ul className="space-y-1.5">
                {projects.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-fg-2" title={p.places.map((x) => x.project.path).join("\n")}>
                      {p.name}
                      {p.branches[0] && <span className="ml-1.5 font-mono text-[11px] text-faint">{p.branches[0]}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted">{formatTokens(p.totals.tokens)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">Only the team&apos;s owner and admins see other members&apos; computers, sessions, projects and limits.</p>
      )}
      {member.detailed && sessions.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="eyebrow">latest sessions</p>
            <button type="button" onClick={() => onShowSessions({ person: member.id })} className="text-[11px] text-muted hover:text-fg">
              all {sessions.length} →
            </button>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {sessions.slice(0, RECENT_SESSIONS).map((s) => (
              <SessionLine key={s.key} s={s} showMember={false} now={now} onOpen={() => onOpenSession(s.key)} />
            ))}
          </ul>
        </div>
      )}
      {(canSetRole || canRemove) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {canSetRole && (
            <label className="flex items-center gap-2 text-xs text-muted">
              role
              <select value={member.role ?? "member"} disabled={busy} onChange={(e) => changeRole(e.target.value as Role)} className={input}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner (hand over the team)</option>
              </select>
            </label>
          )}
          {canRemove && (
            <button type="button" disabled={busy} onClick={remove} className="btn border-rose-500/40 text-rose-600 dark:text-rose-400">
              <Icon name="trash" />
              Remove from team
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** An account's windows from its last reading, as small meters. */
function AccountLimits({ account, now }: { account: MemberAccount; now: number }) {
  const meta = PROVIDER_META[account.provider];
  const plan = formatPlan(account.plan ?? account.usage?.plan);
  return (
    <div className="mb-2 rounded-lg border border-line bg-panel px-3 py-2">
      <p className="flex items-center gap-1.5 truncate text-sm text-fg">
        <ProviderGlyph provider={account.provider} size={13} />
        <span className="truncate">{account.label}</span>
        {plan && <span className="rounded-md bg-panel-3 px-1.5 py-px text-[11px] text-fg-2">{plan}</span>}
      </p>
      {account.usage ? (
        <>
          {account.usage.windows.map((w) => {
            const left = Math.max(0, 100 - w.usedPercent);
            const resetMs = w.resetsAt ? new Date(w.resetsAt).getTime() - now : null;
            return (
              <div key={w.key} className="mt-1.5">
                <div className="flex justify-between gap-2 font-mono text-[11px]">
                  <span className="truncate text-muted">{w.label}</span>
                  <span className={w.usedPercent >= 90 ? "text-rose-600 dark:text-rose-300" : "text-fg-2"}>
                    {Math.round(left)}% left{resetMs !== null && resetMs > 0 ? ` · ${formatCountdown(resetMs)}` : ""}
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-track">
                  <div className="h-full rounded-full" style={{ width: `${w.usedPercent}%`, background: w.usedPercent >= 90 ? "#f43f5e" : meta.accent }} />
                </div>
              </div>
            );
          })}
          <p className="mt-1.5 font-mono text-[10px] text-faint">read {formatAgo(now - new Date(account.usage.fetchedAt).getTime())} by its owner&apos;s dashboard</p>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-faint">No reading yet: it comes when its owner&apos;s dashboard polls it.</p>
      )}
    </div>
  );
}

function InviteCard({ ws, now, reload, flash }: { ws: Workspace; now: number; reload: () => Promise<void>; flash: (text: string) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRoleChoice] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ url: string; invite: Invite } | null>(null);
  const [copied, setCopied] = useState(false);
  const team = ws.team!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createInvite(team.id, email.trim() || null, role);
    setBusy(false);
    if (!res.ok) return flash(res.error);
    setMade(res.data);
    setCopied(false);
    setEmail("");
    await reload();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("Copy the invite link:", url);
    }
  }

  async function revoke(invite: Invite) {
    const res = await revokeInvite(team.id, invite.id);
    if (!res.ok) return flash(res.error);
    if (made?.invite.id === invite.id) setMade(null);
    await reload();
  }

  return (
    <Card title="Invite people">
      <div className="space-y-3 px-4 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="min-w-56 flex-1">
            <span className="eyebrow">email · optional</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="anyone with the link, if empty" className={`mt-1 w-full ${input}`} />
          </label>
          <label>
            <span className="eyebrow">as</span>
            <select value={role} onChange={(e) => setRoleChoice(e.target.value as Role)} className={`mt-1 block ${input}`}>
              <option value="member">Member</option>
              {ws.role === "owner" && <option value="admin">Admin</option>}
            </select>
          </label>
          <button type="submit" disabled={busy} className="btn btn-primary">
            <Icon name="link" />
            {busy ? "…" : "Create invite link"}
          </button>
        </form>
        {made && (
          <div className="fade-in rounded-lg border border-accent/40 bg-panel-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{made.url}</code>
              <button type="button" onClick={() => void copy(made.url)} className="btn">
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-faint">
              Send it yourself: this is the only time it is shown. It works once, for {made.invite.email ?? "whoever opens it first"}, within 7 days.
            </p>
          </div>
        )}
        <p className="text-[11px] text-faint">
          Joining lets the owner and admins see that person&apos;s connected computers, every Claude Code and Codex session there (when, where, which models,
          how many tokens), their projects and account limits, and start sessions on their computers where they allow it. Session titles and conversations
          only from computers set to share them; never account credentials.
        </p>
      </div>
      {ws.invites.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {ws.invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-2">
              <Icon name="link" size={13} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{i.email ?? "anyone with the link"}</span>
              <RoleBadge role={i.role} />
              <span className="shrink-0 font-mono text-[11px] text-muted">expires in {formatCountdown(i.expiresAt - now)}</span>
              <button type="button" onClick={() => void revoke(i)} className="text-[11px] text-faint hover:text-rose-500">
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {ws.invites.length === 0 && !made && <Empty>No pending invites.</Empty>}
    </Card>
  );
}
