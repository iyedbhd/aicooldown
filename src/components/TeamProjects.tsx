"use client";

import { useState } from "react";
import { formatTokens, lastDays } from "@/lib/activity";
import { formatAgo, formatMoney } from "@/lib/format";
import type { SharingChange, Workspace } from "@/lib/team";
import { rollupProjects, type Period, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { ShareMenu } from "./ShareMenu";
import { Avatar, Card, Empty } from "./TeamBits";
import { SessionLine, type SessionFilter } from "./TeamSessions";

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  period: Period;
  now: number;
  onShowSessions: (only: Partial<SessionFilter>) => void;
  onOpenSession: (key: string) => void;
  onShare: (change: SharingChange) => Promise<void>;
};

/** The latest sessions an open project shows. */
const LATEST = 5;

/**
 * What people work on: each project across everyone's computers, busiest
 * first, and opened, where and by whom and its latest sessions. Everyone
 * shares their own projects from here, by name (on all of their computers),
 * with whom they pick; projects others share with you show here too.
 */
export function TeamProjects({ ws, sessions, period, now, onShowSessions, onOpenSession, onShare }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  // Everyone the viewer sees work of: all of it, or what they share with the viewer.
  const projects = rollupProjects(
    ws.members.filter((m) => m.detailed || m.devices.length > 0),
    lastDays(period, now)[0],
  );

  return (
    <Card title={`${projects.length} project${projects.length === 1 ? "" : "s"} · last ${period} days`}>
      {projects.length === 0 ? (
        <Empty>No Claude Code or Codex activity on the connected computers in the last {period} days.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {projects.map((p) => {
            const expanded = open === p.name;
            const mine = Boolean(ws.team) && p.places.some((x) => x.member.id === ws.me.id);
            const theirs = p.places.some((x) => !x.member.detailed);
            return (
              <li key={p.name} className="relative">
                {mine && (
                  <span className="absolute right-4 top-3 z-10">
                    <ShareMenu ws={ws} kind="project" item={p.name} onShare={onShare} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : p.name)}
                  aria-expanded={expanded}
                  className={`flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-panel-2 ${mine ? "pr-32" : ""}`}
                >
                  <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                    <Icon name="folder" size={16} className="shrink-0 text-faint" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-fg">{p.name}</span>
                        {p.tools.map((t) => (
                          <ProviderGlyph key={t} provider={t} size={12} />
                        ))}
                        {theirs && <span className="chip">shared with you</span>}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {p.branches.length ? `${p.branches.slice(0, 3).join(", ")} · ` : ""}
                        {p.sessions} session{p.sessions === 1 ? "" : "s"} · active {formatAgo(now - p.lastActive)}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-5">
                    {ws.team && (
                      <span className="flex -space-x-1.5">
                        {p.people.slice(0, 5).map((m) => (
                          <span key={m.id} title={m.email} className="rounded-full ring-2 ring-panel">
                            <Avatar email={m.email} size={22} />
                          </span>
                        ))}
                      </span>
                    )}
                    <span className="w-20 text-right">
                      <span className="block font-mono text-sm tabular-nums text-fg">{formatTokens(p.totals.tokens)}</span>
                      <span className="block font-mono text-[11px] text-muted">{p.totals.cost > 0 ? `≈ ${formatMoney(p.totals.cost)}` : "—"}</span>
                    </span>
                    <Icon name="chevron" size={12} className={`text-faint transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </span>
                </button>
                {expanded && (
                  <ul className="space-y-1.5 border-t border-line bg-panel-2/40 px-4 py-3">
                    {p.places.map(({ member, device, project, totals }) => (
                      <li key={`${device.id}:${project.tool}:${project.path}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <ProviderGlyph provider={project.tool} size={12} />
                        {ws.team && <span className="text-fg-2">{member.email}</span>}
                        <span className="flex items-center gap-1 text-muted">
                          <Icon name="monitor" size={11} />
                          {device.name}
                        </span>
                        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{project.path}</code>
                        {project.branch && <span className="font-mono text-[11px] text-muted">{project.branch}</span>}
                        <span className="font-mono text-[11px] text-fg-2">{formatTokens(totals.tokens)}</span>
                      </li>
                    ))}
                    {(() => {
                      const theirs = sessions.filter((s) => s.project === p.name);
                      return (
                        theirs.length > 0 && (
                          <li className="pt-1.5">
                            <p className="eyebrow mb-1">latest sessions</p>
                            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
                              {theirs.slice(0, LATEST).map((s) => (
                                <SessionLine key={s.key} s={s} showMember={Boolean(ws.team)} now={now} onOpen={() => onOpenSession(s.key)} />
                              ))}
                            </ul>
                          </li>
                        )
                      );
                    })()}
                    <li>
                      <button type="button" onClick={() => onShowSessions({ project: p.name })} className="mt-1 text-xs text-muted hover:text-fg">
                        All its sessions →
                      </button>
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
