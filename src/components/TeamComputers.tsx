"use client";

import { useState } from "react";
import { formatTokens, lastDays } from "@/lib/activity";
import { formatAgo, formatMoney } from "@/lib/format";
import type { ScheduleMode } from "@/lib/local";
import {
  CHAT_VERSION,
  mayRunOn,
  REMOTE_HELP,
  REMOTE_LABEL,
  removeDevice,
  renameDevice,
  sendCommand,
  SHARE_HELP,
  TOOL_NAME,
  unavailable,
  versionAtLeast,
  type Device,
  type Member,
  type NewCommand,
  type ToolState,
  type Workspace,
} from "@/lib/team";
import type { Tool } from "@/lib/activity";
import { fullestWindow, totalsSince, type Period, type SessionRow } from "@/lib/team-stats";
import { confirmAction } from "@/lib/ui";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { Avatar, Card, Empty, OnlineDot } from "./TeamBits";
import type { SessionFilter } from "./TeamSessions";

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  period: Period;
  now: number;
  reload: () => Promise<void>;
  flash: (text: string) => void;
  onNewChat: (deviceId: string) => void;
  onShowSessions: (only: Partial<SessionFilter>) => void;
};

const REMOTE_TONE = { off: "", read: "chip-good", edit: "chip-warn", full: "chip-bad" } as const;
const SHARE_CHIP = { off: "session content private", on: "session content on the website" } as const;
const TOOL_TONE: Record<ToolState, string> = { ready: "text-emerald-600 dark:text-emerald-400", "signed-out": "text-amber-600 dark:text-amber-300", missing: "text-faint" };
const TOOL_WORD: Record<ToolState, string> = { ready: "ready", "signed-out": "not signed in", missing: "not installed" };

/** The connected computers: what they are, whose accounts their CLIs use, what they work on, what they share, and what remote sessions may do there. */
export function TeamComputers(props: Props) {
  const { ws } = props;
  // Someone who only shares some work with the viewer lends their computers' names to it, and shows none here.
  const devices = ws.members.filter((m) => m.detailed).flatMap((m) => m.devices.map((d) => ({ device: d, owner: m })));
  if (devices.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line p-8 text-center">
        <Icon name="monitor" size={28} className="mx-auto text-faint" />
        <h3 className="mt-3 text-base font-medium text-fg">No computers connected yet</h3>
        <ol className="mx-auto mt-3 max-w-lg space-y-1.5 text-left text-sm text-muted">
          <li>1. Install the AI Cooldown desktop app on the computer (or run your own copy there).</li>
          <li>2. Sign in with {ws.team ? "your" : "this"} AI Cooldown account.</li>
          <li>
            3. Under <span className="text-fg-2">This machine</span>, press <span className="text-fg-2">Connect this computer</span>. It then reports which accounts its CLIs
            use and its Claude Code and Codex sessions: when, in which folder, with which models, how many tokens, prompts and changed lines. What they say stays there unless its owner
            turns on sharing.
          </li>
          <li>
            4. To chat with its Claude Code and Codex sessions from here, choose in the same place what remote sessions may do, and who may read what sessions
            say. Both are off until then.
          </li>
        </ol>
      </div>
    );
  }
  // In a team, each person's computers together: someone signed in on several shows as one person with all of them.
  const people = ws.members.filter((m) => m.detailed && m.devices.length > 0);
  return (
    <div className="space-y-6">
      <LoginsCard ws={ws} />
      {ws.team && people.length > 0
        ? people.map((m) => (
            <section key={m.id}>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-fg-2">
                <Avatar email={m.email} size={20} />
                <span className="truncate">{m.id === ws.me.id ? "Your computers" : m.email}</span>
                <span className="font-mono text-[11px] font-normal text-faint">
                  {m.devices.filter((d) => d.online).length}/{m.devices.length} online
                </span>
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                {m.devices.map((device) => (
                  <DeviceCard key={device.id} {...props} device={device} ownerEmail={m.email} />
                ))}
              </div>
            </section>
          ))
        : (
            <div className="grid gap-4 md:grid-cols-2">
              {devices.map(({ device, owner }) => (
                <DeviceCard key={device.id} {...props} device={device} ownerEmail={owner.email} />
              ))}
            </div>
          )}
    </div>
  );
}

type Login = { tool: Tool; email: string; places: { device: Device; owner: Member }[] };

/**
 * Each account the computers' CLIs are signed in with, and where: an account
 * signed in on several computers shares one set of limits between them, so
 * its usage there adds up. With the limits it last read, where someone linked
 * that account.
 */
function LoginsCard({ ws }: { ws: Workspace }) {
  const logins = new Map<string, Login>();
  for (const owner of ws.members.filter((m) => m.detailed)) {
    for (const device of owner.devices) {
      for (const tool of ["claude", "codex"] as const) {
        const email = device.logins[tool];
        if (!email) continue;
        const key = `${tool}:${email.toLowerCase()}`;
        const login = logins.get(key) ?? { tool, email, places: [] };
        login.places.push({ device, owner });
        logins.set(key, login);
      }
    }
  }
  const list = [...logins.values()].sort((a, b) => b.places.length - a.places.length || a.email.localeCompare(b.email));
  if (list.length === 0) return null;
  const accounts = ws.members.flatMap((m) => m.accounts);
  const shared = list.filter((l) => l.places.length > 1).length;
  return (
    <Card title={`Logins · ${list.length}`} action={shared > 0 ? <span className="font-mono text-[11px] text-amber-700 dark:text-amber-300">{shared} on several computers</span> : undefined}>
      <ul className="divide-y divide-line">
        {list.map((l) => {
          const account = accounts.find((a) => a.provider === l.tool && a.label.toLowerCase() === l.email.toLowerCase());
          const window = account && fullestWindow(account);
          return (
            <li key={`${l.tool}:${l.email}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
              <ProviderGlyph provider={l.tool} size={13} />
              <span className="min-w-0 truncate font-mono text-[12px] text-fg-2">{l.email}</span>
              {window && (
                <span className={`font-mono text-[11px] ${window.usedPercent >= 90 ? "text-rose-600 dark:text-rose-300" : "text-muted"}`} title={window.label}>
                  {Math.round(window.usedPercent)}% of a limit used
                </span>
              )}
              <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {l.places.map(({ device, owner }) => (
                  <span key={device.id} className={`chip ${l.places.length > 1 ? "chip-warn" : ""}`} title={ws.team ? owner.email : undefined}>
                    <Icon name="monitor" size={11} />
                    {device.name}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {shared > 0 && (
        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
          One account on several computers shares its 5-hour and weekly limits between them: what each computer uses counts against the same limits.
        </p>
      )}
    </Card>
  );
}

type CardProps = Props & { device: Device; ownerEmail: string };

function DeviceCard({ ws, sessions, device: d, ownerEmail, period, now, reload, flash, onNewChat, onShowSessions }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const theirs = sessions.filter((s) => s.device.id === d.id);
  const live = theirs.filter((s) => s.active).length;
  const projects = d.activity?.projects ?? [];
  const totals = totalsSince(projects, lastDays(period, now)[0]);
  // Most recent first, each folder once (Claude Code and Codex may both have worked in it).
  const top = [...projects]
    .sort((a, b) => b.lastActive - a.lastActive)
    .filter((p, i, all) => all.findIndex((q) => q.path === p.path) === i)
    .slice(0, 3);
  const own = d.userId === ws.me.id;
  const why = unavailable(d);

  async function saveName() {
    const label = naming?.trim() ?? "";
    setNaming(null);
    if (label === (d.label ?? "")) return;
    const res = await renameDevice(d.id, label);
    if (!res.ok) return flash(res.error);
    await reload();
  }

  async function remove() {
    if (
      !(await confirmAction({
        title: `Remove ${d.name}?`,
        body: "Its remote sessions go with it. If AI Cooldown still runs there, it just stops being connected.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    const res = await removeDevice(d.id);
    setBusy(false);
    if (!res.ok) return flash(res.error);
    flash(`Removed ${d.name}.`);
    await reload();
  }

  return (
    <section className="fade-in flex flex-col rounded-2xl border border-line bg-panel">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2">
          <Icon name="monitor" size={17} className="text-fg-2" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            {naming !== null ? (
              <input
                autoFocus
                value={naming}
                maxLength={60}
                placeholder={d.hostname}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setNaming(null);
                }}
                aria-label="Name this computer"
                className="min-w-0 flex-1 border-b border-muted bg-transparent text-base font-semibold text-fg focus:outline-none"
              />
            ) : own ? (
              <button type="button" onClick={() => setNaming(d.label ?? "")} className="group flex min-w-0 items-center gap-2 text-left" title="Name it">
                <h3 className="truncate text-base font-semibold text-fg">{d.name}</h3>
                <span className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100">rename</span>
              </button>
            ) : (
              <h3 className="truncate text-base font-semibold text-fg">{d.name}</h3>
            )}
            <OnlineDot online={d.online} lastSeenAt={d.lastSeenAt} now={now} />
          </div>
          <p className="truncate font-mono text-[11px] text-muted">
            {d.label ? `${d.hostname} · ` : ""}
            {d.os} · {d.arch} · AI Cooldown {d.version}
          </p>
          {ws.team && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-2">
              <Avatar email={ownerEmail} size={16} />
              {own ? "yours" : ownerEmail}
            </p>
          )}
        </div>
      </header>

      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1">
          {(["claude", "codex"] as const).map((p) => {
            const account = ws.members.find((m) => m.id === d.userId)?.accounts.find((a) => a.provider === p && d.logins[p] && a.label.toLowerCase() === d.logins[p]!.toLowerCase());
            const window = account && fullestWindow(account);
            return (
              <p key={p} className="flex items-center gap-2 text-xs">
                <ProviderGlyph provider={p} size={13} />
                <span className="w-24 shrink-0 whitespace-nowrap text-muted">{TOOL_NAME[p]}</span>
                <span className={`truncate font-mono text-[11px] ${d.logins[p] ? "text-fg-2" : "text-faint"}`}>{d.logins[p] ?? "no login seen"}</span>
                {window && (
                  <span className={`shrink-0 font-mono text-[10px] ${window.usedPercent >= 90 ? "text-rose-600 dark:text-rose-300" : "text-muted"}`} title={window.label}>
                    {Math.round(window.usedPercent)}% used
                  </span>
                )}
                <span className={`ml-auto shrink-0 font-mono text-[10px] ${TOOL_TONE[d.tools[p]]}`} title="Whether remote sessions can run with it there">
                  {TOOL_WORD[d.tools[p]]}
                </span>
              </p>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ${REMOTE_TONE[d.remote]}`} title={REMOTE_HELP[d.remote]}>
            <Icon name="shield" size={11} />
            remote sessions: {REMOTE_LABEL[d.remote].toLowerCase()}
          </span>
          <span className="chip" title={SHARE_HELP[d.share]}>
            <Icon name={d.share === "off" ? "lock" : "eye"} size={11} />
            {SHARE_CHIP[d.share]}
          </span>
          {!d.connected && <span className="chip chip-bad">disconnected: its owner signs in there again to reconnect</span>}
        </div>

        {d.activity ? (
          <div>
            <p className="font-mono text-[11px] text-muted">
              {formatTokens(totals.tokens)} tokens · {period} days{totals.cost > 0 ? ` · ≈ ${formatMoney(totals.cost)}` : ""} · read {formatAgo(now - d.activity.scannedAt)}
            </p>
            {theirs.length > 0 && (
              <button type="button" onClick={() => onShowSessions({ computer: d.id })} className="mt-1 flex items-center gap-1.5 text-xs text-fg-2 hover:text-fg">
                {live > 0 && <span className="live h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />}
                {theirs.length} session{theirs.length === 1 ? "" : "s"} in {d.activity.days} days{live > 0 ? `, ${live} live now` : ""} →
              </button>
            )}
            <ul className="mt-1.5 space-y-1">
              {top.map((p) => (
                <li key={p.path} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-fg-2" title={p.path}>
                    <Icon name="folder" size={12} className="shrink-0 text-faint" />
                    <span className="truncate">{p.name}</span>
                    {p.branch && <span className="truncate font-mono text-[11px] text-faint">{p.branch}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{formatAgo(now - p.lastActive)}</span>
                </li>
              ))}
              {projects.length === 0 && <li className="text-xs text-muted">No Claude Code or Codex sessions in the last {d.activity.days} days.</li>}
            </ul>
          </div>
        ) : (
          <Empty>Waiting for its first report.</Empty>
        )}
        {own && <Manage device={d} now={now} reload={reload} flash={flash} />}
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-[11px] text-faint">{mayRunOn(ws, d) ? (why ? `Sessions: ${why}` : "Ready for a session") : "Its owner or a team admin can start sessions"}</span>
        <div className="flex gap-2">
          {own && (
            <button type="button" disabled={busy} onClick={() => void remove()} className="rounded-lg p-1.5 text-muted transition hover:bg-rose-500/15 hover:text-rose-500" aria-label={`Remove ${d.name}`} title="Remove this computer">
              <Icon name="trash" size={15} />
            </button>
          )}
          {mayRunOn(ws, d) && (
            <button type="button" disabled={Boolean(why)} onClick={() => onNewChat(d.id)} className="btn">
              <Icon name="terminal" />
              New chat
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

const COMMAND_TONE = { queued: "text-muted", running: "text-amber-600 dark:text-amber-300", done: "text-emerald-600 dark:text-emerald-400", failed: "text-rose-600 dark:text-rose-400" } as const;
const WHEN: Record<ScheduleMode, string> = { at: "at a set time", reset: "at the next reset", "every-reset": "after every reset" };

/**
 * One of your own computers, from anywhere: which saved login each CLI uses,
 * saying hello to start a 5-hour window now or on a schedule, and how the
 * last few of those went. The computer does it when it next checks in,
 * within seconds while this page is open.
 */
function Manage({ device: d, now, reload, flash }: { device: Device; now: number; reload: () => Promise<void>; flash: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ profileId: string; mode: ScheduleMode; at: string }>({ profileId: "", mode: "reset", at: "" });
  if (!versionAtLeast(d.version, CHAT_VERSION)) {
    return <p className="text-[11px] text-faint">Update AI Cooldown on {d.name} to {CHAT_VERSION} or later to manage its logins from here.</p>;
  }
  const manage = d.manage;
  const profiles = manage?.profiles ?? [];
  const waiting = d.commands.some((c) => c.status === "queued" || c.status === "running");

  async function send(command: NewCommand) {
    setBusy(true);
    const res = await sendCommand(d.id, command);
    setBusy(false);
    if (!res.ok) return flash(res.error);
    flash(`${res.data.command.label}: sent to ${d.name}.`);
    // It is done within seconds while this page keeps the computer checking in often.
    for (const ms of [2_500, 6_000, 12_000]) setTimeout(() => void reload(), ms);
    await reload();
  }

  return (
    <div className="rounded-xl border border-line bg-panel-2/60">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-fg-2">
        <span className="flex items-center gap-1.5">
          <Icon name="user" size={12} />
          Manage logins and hellos
          {waiting && <span className="live h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="working" />}
        </span>
        <Icon name="chevron" size={12} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {(["claude", "codex"] as const).map((p) => {
            const mine = profiles.filter((x) => x.provider === p);
            const liveSaved = mine.some((x) => x.active);
            return (
              <div key={p}>
                <p className="flex items-center gap-1.5 text-[11px] text-muted">
                  <ProviderGlyph provider={p} size={11} />
                  {TOOL_NAME[p]} uses {d.logins[p] ?? "no login"}
                  {d.logins[p] && !liveSaved && (
                    <button type="button" disabled={busy} onClick={() => void send({ kind: "save", provider: p })} className="ml-1 underline decoration-dotted hover:text-fg">
                      save it
                    </button>
                  )}
                </p>
                {mine.length === 0 ? (
                  <p className="mt-1 text-[11px] text-faint">No saved logins. Save the one it uses to switch back to it later.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {mine.map((x) => {
                      const hello = manage?.hellos[x.id];
                      return (
                        <li key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`min-w-0 flex-1 truncate ${x.active ? "text-fg" : "text-fg-2"}`}>
                            {x.label}
                            {x.plan && <span className="ml-1 text-[10px] text-faint">{x.plan}</span>}
                            {x.active && <span className="ml-1.5 chip chip-good">in use</span>}
                          </span>
                          {hello && (
                            <span className={`font-mono text-[10px] ${hello.ok ? "text-faint" : "text-rose-600 dark:text-rose-400"}`} title={hello.message}>
                              hello {formatAgo(now - hello.at)}
                            </span>
                          )}
                          {!x.active && (
                            <button type="button" disabled={busy} onClick={() => void send({ kind: "switch", profileId: x.id })} className="btn">
                              Use
                            </button>
                          )}
                          <button type="button" disabled={busy} onClick={() => void send({ kind: "hello", profileId: x.id })} className="btn" title="Starts its 5-hour window now">
                            Say hello
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}

          <div>
            <p className="text-[11px] text-muted">Scheduled hellos</p>
            {(manage?.schedules ?? []).length === 0 ? (
              <p className="mt-1 text-[11px] text-faint">None.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {manage!.schedules.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-fg-2">
                      {profiles.find((x) => x.id === s.profileId)?.label ?? "a saved login"} · {WHEN[s.mode]}
                      <span className="ml-1 font-mono text-[10px] text-faint">next {new Date(s.at).toLocaleString()}</span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => void send({ kind: "cancel", scheduleId: s.id })} className="text-[11px] text-faint hover:text-rose-500">
                      cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {profiles.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <select value={plan.profileId} onChange={(e) => setPlan({ ...plan, profileId: e.target.value })} aria-label="Saved login" className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-fg">
                  <option value="">Say hello with…</option>
                  {profiles.map((x) => (
                    <option key={x.id} value={x.id}>
                      {TOOL_NAME[x.provider]} · {x.label}
                    </option>
                  ))}
                </select>
                <select value={plan.mode} onChange={(e) => setPlan({ ...plan, mode: e.target.value as ScheduleMode })} aria-label="When" className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-fg">
                  <option value="reset">at the next reset</option>
                  <option value="every-reset">after every reset</option>
                  <option value="at">at a time…</option>
                </select>
                {plan.mode === "at" && (
                  <input
                    type="datetime-local"
                    value={plan.at}
                    onChange={(e) => setPlan({ ...plan, at: e.target.value })}
                    aria-label="Time"
                    className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-fg"
                  />
                )}
                <button
                  type="button"
                  disabled={busy || !plan.profileId || (plan.mode === "at" && !plan.at)}
                  onClick={() => void send({ kind: "schedule", profileId: plan.profileId, mode: plan.mode, at: plan.mode === "at" ? new Date(plan.at).getTime() : undefined })}
                  className="btn"
                >
                  Schedule
                </button>
              </div>
            )}
          </div>

          {d.commands.length > 0 && (
            <div>
              <p className="text-[11px] text-muted">Lately</p>
              <ul className="mt-1 space-y-0.5">
                {d.commands.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-fg-2" title={c.message ?? undefined}>
                      {c.label}
                      {c.status === "failed" && c.message ? `: ${c.message}` : ""}
                    </span>
                    <span className={`shrink-0 font-mono text-[10px] ${COMMAND_TONE[c.status]}`}>
                      {c.status} · {formatAgo(now - (c.finishedAt ?? c.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
