"use client";

import { useState } from "react";
import { formatTokens, type Tool } from "@/lib/activity";
import { formatAgo, formatMoney } from "@/lib/format";
import { REMOTE_LABEL, TOOL_NAME, type Run, type Workspace } from "@/lib/team";
import { liveNow, sourceLabel, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { Avatar, Card, Empty, StatusChip } from "./TeamBits";

/** Which sessions the list shows. The console keeps it, so other tabs can link to a person's, a computer's or a project's sessions. */
export type SessionFilter = { person: string; computer: string; project: string; tool: "all" | Tool; remoteOnly: boolean; search: string };

export const NO_FILTER: SessionFilter = { person: "all", computer: "all", project: "all", tool: "all", remoteOnly: false, search: "" };

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  now: number;
  filter: SessionFilter;
  onFilter: (filter: SessionFilter) => void;
  /** A new conversation on one of the computers, when the viewer may start one. */
  onNewChat: (() => void) | undefined;
  onOpenRun: (id: string) => void;
  onOpenSession: (key: string) => void;
};

const PAGE = 50;
const control = "rounded-lg border border-line bg-panel-2 px-2 py-1 text-xs text-fg";

/** How the list reads: one list, most recent first, or grouped by day (what happened when), project, person or computer. */
type Grouping = "list" | "day" | "project" | "person" | "computer";

const GROUPINGS: { id: Grouping; label: string; team?: boolean }[] = [
  { id: "list", label: "List" },
  { id: "day", label: "By day" },
  { id: "project", label: "By project" },
  { id: "person", label: "By person", team: true },
  { id: "computer", label: "By computer" },
];

/** The grouping last picked, per browser. */
const GROUP_KEY = "aic:sessions-group";
/** Sessions a group shows before "all of them". */
const GROUP_PAGE = 5;

function storedGrouping(): Grouping {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return GROUPINGS.some((g) => g.id === v) ? (v as Grouping) : "list";
  } catch {
    return "list";
  }
}

type Group = { key: string; label: string; detail: string | null; sessions: SessionRow[]; tokens: number; cost: number; live: number; lastActive: number };

/** A day as people say it: today, yesterday, or its name and date. */
function dayName(t: number, now: number): string {
  const day = new Date(t).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86400_000).toDateString()) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** The sessions in groups, each with its totals: days newest first, the rest most recently active first. */
function groupSessions(sessions: SessionRow[], by: Grouping, now: number, team: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const s of sessions) {
    const [key, label, detail] =
      by === "day"
        ? [new Date(s.lastActive).toDateString(), dayName(s.lastActive, now), null]
        : by === "project"
          ? [s.project, s.project, null]
          : by === "person"
            ? [s.member.id, s.member.email, null]
            : [s.device.id, s.device.name, team ? s.member.email : null];
    const g = groups.get(key) ?? { key, label, detail, sessions: [], tokens: 0, cost: 0, live: 0, lastActive: 0 };
    g.sessions.push(s);
    g.tokens += s.totals.tokens;
    g.cost += s.totals.cost;
    g.live += s.active ? 1 : 0;
    g.lastActive = Math.max(g.lastActive, s.lastActive);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.lastActive - a.lastActive);
}

function matches(s: SessionRow, f: SessionFilter, needle: string): boolean {
  return (
    (f.person === "all" || s.member.id === f.person) &&
    (f.computer === "all" || s.device.id === f.computer) &&
    (f.project === "all" || s.project === f.project) &&
    (f.tool === "all" || s.tool === f.tool) &&
    (!f.remoteOnly || s.run !== null) &&
    (!needle || [s.title, s.path, s.branch, s.device.name, s.member.email].some((v) => v?.toLowerCase().includes(needle)))
  );
}

/**
 * Every Claude Code and Codex session on the computers the viewer may see:
 * what runs now, then all of them with filters, each opening as a chat to
 * read and continue. Below, the ones started from here.
 */
export function TeamSessions({ ws, sessions, now, filter, onFilter, onNewChat, onOpenRun, onOpenSession }: Props) {
  const [shown, setShown] = useState(PAGE);
  const [grouping, setGrouping] = useState<Grouping>(storedGrouping);
  /** The groups showing all of their sessions. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const set = (patch: Partial<SessionFilter>) => {
    onFilter({ ...filter, ...patch });
    setShown(PAGE);
  };
  function pickGrouping(next: Grouping) {
    setGrouping(next);
    setExpanded(new Set());
    try {
      localStorage.setItem(GROUP_KEY, next);
    } catch {
      /* remembering it is a nicety */
    }
  }

  const live = liveNow(ws, sessions);
  const needle = filter.search.trim().toLowerCase();
  const filtered = sessions.filter((s) => matches(s, filter, needle));
  const people = ws.members.filter((m) => m.detailed && m.devices.length > 0);
  const devices = ws.members.flatMap((m) => m.devices);
  const projects = [...new Set(sessions.map((s) => s.project))].sort((a, b) => a.localeCompare(b));
  const filtering = JSON.stringify(filter) !== JSON.stringify(NO_FILTER);
  const privateComputers = devices.filter((d) => d.share === "off").length;
  const team = Boolean(ws.team);
  const by = grouping === "person" && !team ? "list" : grouping;
  const groups = by === "list" ? null : groupSessions(filtered, by, now, team);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Open any session to read it and send the next message: the computer runs it as the next turn of the same conversation, whether it started in a terminal,
          an IDE, the Claude or Codex desktop apps, or here.
        </p>
        {onNewChat ? (
          <button type="button" onClick={onNewChat} className="btn btn-primary">
            <Icon name="terminal" />
            New chat
          </button>
        ) : (
          <span className="text-[11px] text-faint">
            {team ? "Only the team's owner and admins start sessions on other people's computers. " : ""}Connect a computer and allow remote sessions on it, under This
            machine in AI Cooldown there.
          </span>
        )}
      </div>

      {(live.sessions.length > 0 || live.runs.length > 0) && (
        <Card title={`Live now · ${live.sessions.length + live.runs.length}`} action={<span className="font-mono text-[11px] text-faint">active in the last 5 min</span>}>
          <ul className="divide-y divide-line">
            {live.runs.map((r) => (
              <RunLine key={r.id} run={r} team={team} now={now} onOpen={() => onOpenRun(r.id)} />
            ))}
            {live.sessions.map((s) => (
              <SessionLine key={s.key} s={s} showMember={team} now={now} onOpen={() => onOpenSession(s.key)} />
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={`Sessions · ${filtered.length}${filtered.length !== sessions.length ? ` of ${sessions.length}` : ""}`}
        action={<span className="font-mono text-[11px] text-faint">last 30 days</span>}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <div role="radiogroup" aria-label="Group sessions" className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel-2 p-0.5">
            {GROUPINGS.filter((g) => team || !g.team).map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={by === g.id}
                onClick={() => pickGrouping(g.id)}
                className={`shrink-0 rounded-md px-2 py-0.5 text-xs transition ${by === g.id ? "bg-panel-3 text-fg" : "text-muted hover:text-fg-2"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          {team && (people.length > 1 || filter.person !== "all") && (
            <select value={filter.person} onChange={(e) => set({ person: e.target.value })} aria-label="Person" className={control}>
              <option value="all">Everyone</option>
              {people.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                </option>
              ))}
            </select>
          )}
          {(devices.length > 1 || filter.computer !== "all") && (
            <select value={filter.computer} onChange={(e) => set({ computer: e.target.value })} aria-label="Computer" className={control}>
              <option value="all">Every computer</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {(projects.length > 1 || filter.project !== "all") && (
            <select value={filter.project} onChange={(e) => set({ project: e.target.value })} aria-label="Project" className={`${control} max-w-48`}>
              <option value="all">Every project</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <select value={filter.tool} onChange={(e) => set({ tool: e.target.value as SessionFilter["tool"] })} aria-label="CLI" className={control}>
            <option value="all">Claude Code and Codex</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={filter.remoteOnly} onChange={(e) => set({ remoteOnly: e.target.checked })} />
            with messages from here
          </label>
          <input
            type="search"
            value={filter.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Search title, folder, branch…"
            aria-label="Search sessions"
            className={`${control} min-w-40 flex-1`}
          />
          {filtering && (
            <button type="button" onClick={() => set(NO_FILTER)} className="text-[11px] text-muted hover:text-fg">
              clear
            </button>
          )}
        </div>
        {privateComputers > 0 && (
          <p className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[11px] text-faint">
            <Icon name="lock" size={11} className="shrink-0" />
            {privateComputers === devices.length ? (devices.length === 1 ? "This computer keeps" : "These computers keep") : `${privateComputers} of ${devices.length} computers keep`}{" "}
            what their sessions say from you: their sessions show without titles, and what was said before can&apos;t be read here.
          </p>
        )}
        {filtered.length === 0 ? (
          <Empty>
            {sessions.length
              ? "No session matches."
              : devices.length
                ? "No sessions reported yet. They come from the connected computers' Claude Code and Codex logs."
                : "No computers connected yet. Sessions come from the Claude Code and Codex logs of the connected computers."}
          </Empty>
        ) : groups ? (
          <div className="divide-y divide-line">
            {groups.map((g) => {
              const all = expanded.has(g.key);
              return (
                <section key={g.key}>
                  <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 bg-panel-2/60 px-4 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {by === "person" && <Avatar email={g.label} size={18} />}
                      <span className="truncate text-sm font-medium text-fg-2">{g.label}</span>
                      {g.detail && <span className="truncate font-mono text-[11px] text-faint">{g.detail}</span>}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      {g.live > 0 && <span className="text-emerald-600 dark:text-emerald-400">{g.live} live · </span>}
                      {g.sessions.length} session{g.sessions.length === 1 ? "" : "s"} · {formatTokens(g.tokens)}
                      {g.cost > 0 ? ` · ≈ ${formatMoney(g.cost)}` : ""}
                    </span>
                  </header>
                  <ul className="divide-y divide-line">
                    {(all ? g.sessions : g.sessions.slice(0, GROUP_PAGE)).map((s) => (
                      <SessionLine key={s.key} s={s} showMember={team && by !== "person"} now={now} onOpen={() => onOpenSession(s.key)} />
                    ))}
                  </ul>
                  {g.sessions.length > GROUP_PAGE && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => new Set(all ? [...prev].filter((k) => k !== g.key) : [...prev, g.key]))}
                      className="w-full border-t border-line px-4 py-1.5 text-left text-[11px] text-muted hover:text-fg"
                    >
                      {all ? "Fewer" : `All ${g.sessions.length}`}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.slice(0, shown).map((s) => (
              <SessionLine key={s.key} s={s} showMember={team} now={now} onOpen={() => onOpenSession(s.key)} />
            ))}
          </ul>
        )}
        {!groups && filtered.length > shown && (
          <div className="border-t border-line px-4 py-2 text-center">
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="btn">
              Show {Math.min(PAGE, filtered.length - shown)} more
            </button>
          </div>
        )}
      </Card>

      <Card title="Started from here" action={<span className="font-mono text-[11px] text-faint">kept 30 days</span>}>
        {ws.runs.length === 0 ? (
          <Empty>No sessions started from the dashboard yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {ws.runs.map((r) => (
              <RunLine key={r.id} run={r} team={team} now={now} onOpen={() => onOpenRun(r.id)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** A session started from the dashboard: its state, prompt, and where. */
export function RunLine({ run: r, team, now, onOpen }: { run: Run; team: boolean; now: number; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-panel-2">
        <StatusChip status={r.status} />
        <ProviderGlyph provider={r.tool} size={13} />
        <span className="min-w-0 flex-1 basis-64 truncate text-sm text-fg">
          {r.resume && <Icon name="refresh" size={11} className="mr-1 inline text-faint" />}
          {r.prompt}
        </span>
        <span className="min-w-0 max-w-full truncate font-mono text-[11px] text-muted sm:shrink-0">
          {r.deviceName} · {r.project.split("/").pop()} · {REMOTE_LABEL[r.mode].toLowerCase()}
          {team ? ` · ${r.by ?? "deleted account"}` : ""} · {formatAgo(now - r.createdAt)}
          {r.result?.costUsd !== undefined ? ` · ${formatMoney(r.result.costUsd)}` : ""}
        </span>
      </button>
    </li>
  );
}

/** A Claude Code or Codex session in a list: what it is about, whose and where, how big, how recent. */
export function SessionLine({ s, showMember, now, onOpen }: { s: SessionRow; showMember: boolean; now: number; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left hover:bg-panel-2">
        <span className="flex min-w-0 flex-1 basis-72 items-center gap-3">
          <span className="relative shrink-0" title={TOOL_NAME[s.tool]}>
            <ProviderGlyph provider={s.tool} size={16} />
            {s.active && <span className="live absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-panel" aria-label="live" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm text-fg">{s.title ?? s.project}</span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {s.title ? `${s.project} · ` : ""}
              {s.branch ? `${s.branch} · ` : ""}
              {s.device.name} · {sourceLabel(s)}
              {s.subagents > 0 ? ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-4">
          {showMember && (
            <span className="flex items-center gap-1.5 text-xs text-fg-2" title={s.member.email}>
              <Avatar email={s.member.email} size={18} />
              <span className="hidden max-w-36 truncate sm:inline">{s.member.email}</span>
            </span>
          )}
          <span className="w-16 text-right">
            <span className="block font-mono text-xs tabular-nums text-fg">{formatTokens(s.totals.tokens)}</span>
            <span className="block font-mono text-[10px] text-muted">{s.totals.cost > 0 ? `≈ ${formatMoney(s.totals.cost)}` : "—"}</span>
          </span>
          <span className="w-20 text-right font-mono text-[11px] text-muted">{s.active ? "now" : formatAgo(now - s.lastActive)}</span>
        </span>
      </button>
    </li>
  );
}
