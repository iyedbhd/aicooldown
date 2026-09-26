import { ACTIVE_MS, rowTokens, sumRows, type ProjectActivity, type SessionActivity, type Tool, type Totals } from "./activity";
import { costOf } from "./pricing";
import type { Device, Member, MemberAccount, Run, Workspace } from "./team";
import type { UsageWindow } from "./types";

export type SessionRow = SessionActivity & {
  /** The session among all of them: its computer, CLI and id. */
  key: string;
  member: Member;
  device: Device;
  /** Its project's name, as the Projects tab groups them. */
  project: string;
  totals: Totals;
  /** The latest remote session in it, when there was one: its first turn, or a message sent from here since. */
  run: Run | null;
  /** Whether its first turn was a remote session. */
  started: boolean;
  active: boolean;
};

const keyOf = (deviceId: string, tool: Tool, id: string) => `${deviceId}:${tool}:${id}`;

/** Every Claude Code and Codex session on the computers the viewer may see, most recently active first. */
export function allSessions(ws: Workspace, now: number): SessionRow[] {
  const runs = new Map<string, Run>();
  const started = new Set<string>();
  for (const r of ws.runs) {
    const key = r.sessionId && keyOf(r.deviceId, r.tool, r.sessionId);
    if (!key) continue;
    if (!runs.has(key)) runs.set(key, r); // newest first: a continued conversation keeps its latest run
    if (r.resume === null) started.add(key);
  }
  return ws.members
    .flatMap((member) =>
      member.devices.flatMap((device) => {
        const projects = new Map((device.activity?.projects ?? []).map((p) => [`${p.tool}:${p.path}`, p.name]));
        return (device.activity?.sessions ?? []).map((s) => {
          const key = keyOf(device.id, s.tool, s.id);
          return {
            ...s,
            key,
            member,
            device,
            project: projects.get(`${s.tool}:${s.path}`) ?? s.path.split("/").pop() ?? s.path,
            totals: sumRows(s.usage),
            run: runs.get(key) ?? null,
            started: started.has(key),
            active: now - s.lastActive < ACTIVE_MS,
          };
        });
      }),
    )
    .sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * What is going on right now: the live sessions, and the remote sessions not
 * among them yet (queued, or started after their computer last reported).
 */
export function liveNow(ws: Workspace, sessions: SessionRow[]): { sessions: SessionRow[]; runs: Run[] } {
  const live = sessions.filter((s) => s.active);
  const keys = new Set(live.map((s) => s.key));
  const runs = ws.runs.filter((r) => (r.status === "queued" || r.status === "running") && !(r.sessionId && keys.has(keyOf(r.deviceId, r.tool, r.sessionId))));
  return { sessions: live, runs };
}

const SOURCES: Record<string, string> = {
  cli: "terminal",
  "claude-desktop": "Claude app",
  "claude-vscode": "VS Code",
  vscode: "VS Code",
  "sdk-cli": "SDK",
  "sdk-ts": "SDK",
  "sdk-py": "SDK",
  "Codex Desktop": "Codex app",
  codex_cli_rs: "terminal",
  codex_exec: "codex exec",
  codex_vscode: "VS Code",
};

/** Where a session ran, in words: "remote" for one started from the dashboard, and what it started in otherwise. */
export const sourceLabel = (s: Pick<SessionRow, "source" | "started">) => (s.started ? "remote" : s.source ? (SOURCES[s.source] ?? s.source) : "—");

const OPEN_IN: Record<string, string> = { "claude-desktop": "the Claude app", cli: "a terminal", "claude-vscode": "VS Code", vscode: "VS Code" };

/** Where a conversation is open (SessionActivity.open), in words: "the Claude app", "a terminal". */
export const openIn = (open: string) => OPEN_IN[open] ?? "another program";

/*
 * What the team page adds up from a workspace: totals over a period, tokens
 * per day, projects across people and computers, and limits running out.
 */

export const PERIODS = [7, 14, 30] as const;
export type Period = (typeof PERIODS)[number];

export const projectsOf = (devices: Device[]): ProjectActivity[] => devices.flatMap((d) => d.activity?.projects ?? []);

/** Totals of these projects' rows from `since` (a day key) on. */
export function totalsSince(projects: ProjectActivity[], since: string): Totals {
  return sumRows(projects.flatMap((p) => p.rows.filter((r) => r.day >= since)));
}

/** The newest activity in these projects, epoch ms; 0 when none. */
export const lastActive = (projects: ProjectActivity[]) => projects.reduce((max, p) => Math.max(max, p.lastActive), 0);

export type DayPoint = { day: string } & Record<Tool, number> & { cost: number };

/** One stack of a chart over days: a tool's, a person's. */
export type Series = { key: string; label: string; color: string; values: number[] };

/** Tokens per day, by tool, on each of `days`. */
export function dailySeries(projects: ProjectActivity[], days: string[]): DayPoint[] {
  const points = new Map(days.map((day) => [day, { day, claude: 0, codex: 0, cost: 0 }]));
  for (const p of projects) {
    for (const r of p.rows) {
      const point = points.get(r.day);
      if (!point) continue;
      point[p.tool] += rowTokens(r);
      point.cost += costOf(r) ?? 0;
    }
  }
  return days.map((day) => points.get(day)!);
}

export type ProjectPlace = { member: Member; device: Device; project: ProjectActivity; totals: Totals };

export type ProjectRollup = {
  name: string;
  tools: Tool[];
  lastActive: number;
  sessions: number;
  branches: string[];
  people: Member[];
  totals: Totals;
  places: ProjectPlace[];
};

/**
 * Projects across people and computers, by folder name: the same repository
 * checked out on two computers is one project. Busiest first.
 */
export function rollupProjects(members: Member[], since: string): ProjectRollup[] {
  const byName = new Map<string, ProjectPlace[]>();
  for (const member of members) {
    for (const device of member.devices) {
      for (const project of device.activity?.projects ?? []) {
        const places = byName.get(project.name) ?? [];
        places.push({ member, device, project, totals: totalsSince([project], since) });
        byName.set(project.name, places);
      }
    }
  }
  const rollups: ProjectRollup[] = [];
  for (const [name, places] of byName) {
    const projects = places.map((p) => p.project);
    const totals = totalsSince(projects, since);
    const recent = lastActive(projects);
    if (totals.tokens === 0 && recent < Date.parse(`${since}T00:00:00`)) continue; // nothing in the period
    rollups.push({
      name,
      tools: [...new Set(projects.map((p) => p.tool))],
      lastActive: recent,
      sessions: projects.reduce((n, p) => n + p.sessions, 0),
      branches: [...new Set(projects.map((p) => p.branch).filter((b): b is string => Boolean(b)))],
      people: [...new Set(places.map((p) => p.member))],
      totals,
      places: places.sort((a, b) => b.totals.tokens - a.totals.tokens),
    });
  }
  return rollups.sort((a, b) => b.totals.tokens - a.totals.tokens || b.lastActive - a.lastActive);
}

/** The account's fullest window in its last reading, or null without one. */
export function fullestWindow(account: MemberAccount): UsageWindow | null {
  const windows = account.usage?.windows ?? [];
  return windows.reduce<UsageWindow | null>((max, w) => (!max || w.usedPercent > max.usedPercent ? w : max), null);
}

export type LimitAlert = { member: Member; account: MemberAccount; window: UsageWindow };

/** Accounts with a window at `threshold`% or more, fullest first. */
export function limitAlerts(members: Member[], threshold = 90): LimitAlert[] {
  const alerts: LimitAlert[] = [];
  for (const member of members) {
    for (const account of member.accounts) {
      const window = fullestWindow(account);
      if (window && window.usedPercent >= threshold) alerts.push({ member, account, window });
    }
  }
  return alerts.sort((a, b) => b.window.usedPercent - a.window.usedPercent);
}
