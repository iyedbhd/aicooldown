"use client";

import { useState } from "react";
import { formatTokens, lastDays } from "@/lib/activity";
import { formatAgo, formatMoney } from "@/lib/format";
import { mayRunOn, REMOTE_HELP, REMOTE_LABEL, removeDevice, unavailable, type Device, type Workspace } from "@/lib/team";
import { totalsSince, type Period, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { Avatar, Empty, OnlineDot } from "./TeamBits";
import type { SessionFilter } from "./TeamSessions";

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  period: Period;
  now: number;
  reload: () => Promise<void>;
  flash: (text: string) => void;
  onNewSession: (deviceId: string) => void;
  onShowSessions: (only: Partial<SessionFilter>) => void;
};

const REMOTE_TONE = { off: "", read: "chip-good", edit: "chip-warn", full: "chip-bad" } as const;

/** The connected computers: what they are, whose accounts their CLIs use, what they work on, what they share, and what remote sessions may do there. */
export function TeamComputers(props: Props) {
  const { ws } = props;
  const devices = ws.members.flatMap((m) => m.devices.map((d) => ({ device: d, owner: m })));
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
            use and its Claude Code and Codex sessions: when, in which folder, with which models, how many tokens. What they say stays there unless its owner
            turns on sharing.
          </li>
          <li>4. To start Claude Code or Codex sessions there from this page, choose what they may do in the same place. They are off until then.</li>
        </ol>
      </div>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {devices.map(({ device, owner }) => (
        <DeviceCard key={device.id} {...props} device={device} ownerEmail={owner.email} />
      ))}
    </div>
  );
}

type CardProps = Props & { device: Device; ownerEmail: string };

function DeviceCard({ ws, sessions, device: d, ownerEmail, period, now, reload, flash, onNewSession, onShowSessions }: CardProps) {
  const [busy, setBusy] = useState(false);
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

  async function remove() {
    if (!window.confirm(`Remove ${d.name}? Its remote sessions go with it. If AI Cooldown still runs there, it just stops being connected.`)) return;
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
            <h3 className="truncate text-base font-semibold text-fg">{d.name}</h3>
            <OnlineDot online={d.online} lastSeenAt={d.lastSeenAt} now={now} />
          </div>
          <p className="truncate font-mono text-[11px] text-muted">
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
          {(["claude", "codex"] as const).map((p) => (
            <p key={p} className="flex items-center gap-2 text-xs">
              <ProviderGlyph provider={p} size={13} />
              <span className="w-28 shrink-0 whitespace-nowrap text-muted">{p === "claude" ? "Claude Code" : "Codex"} CLI</span>
              <span className={`truncate font-mono text-[11px] ${d.logins[p] ? "text-fg-2" : "text-faint"}`}>{d.logins[p] ?? "not signed in"}</span>
            </p>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ${REMOTE_TONE[d.remote]}`} title={REMOTE_HELP[d.remote]}>
            <Icon name="shield" size={11} />
            remote sessions: {REMOTE_LABEL[d.remote].toLowerCase()}
          </span>
          <span
            className={`chip ${d.share ? "chip-warn" : ""}`}
            title={d.share ? "Its sessions show with titles, and their conversations can be read here on request." : "Its sessions show without titles; their conversations stay on the computer."}
          >
            <Icon name={d.share ? "eye" : "lock"} size={11} />
            {d.share ? "session content shared" : "session content private"}
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
            <button type="button" disabled={Boolean(why)} onClick={() => onNewSession(d.id)} className="btn">
              <Icon name="terminal" />
              New session
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
