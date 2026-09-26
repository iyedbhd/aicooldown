import { costOf } from "./pricing";

/*
 * What a connected computer reports about the work its Claude Code and Codex
 * CLIs did, read from their own session logs there (server/local/activity.ts):
 * per project, per day and model, how many tokens went where; per project and
 * day, how many prompts, file changes and commands, and when; and each
 * session. Session titles only from a computer that shares session content;
 * never prompts, code or replies (a shared session's conversation travels
 * separately, when asked for: server/transcripts.ts).
 */

export type Tool = "claude" | "codex";

/** One model's tokens on one day in one project. `cacheWrite1h` is the part of `cacheWrite` cached for an hour. */
export type TokenRow = {
  /** YYYY-MM-DD, in the computer's own time zone. */
  day: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Model replies. */
  messages: number;
};

/**
 * The quarter hours of a day with any activity, in the computer's own time: 96
 * bits as 24 hex digits, one digit per hour, its top bit the hour's first
 * quarter. "8000…" is 00:00-00:15.
 */
export type Quarters = string;

/**
 * What a project's sessions did on one day besides reading and writing
 * tokens. Counts and times only, never what was said or changed.
 */
export type WorkRow = {
  /** YYYY-MM-DD, in the computer's own time zone. */
  day: string;
  /** Prompts people typed: not the CLI's own messages, nor the tasks a session hands its subagents. */
  prompts: number;
  /** Files changed: one for each file an edit, write or patch touched. */
  edits: number;
  /** Lines those changes added and removed. */
  added: number;
  removed: number;
  /** Shell commands run. */
  commands: number;
  /** When any of that, or a model reply, happened. */
  quarters: Quarters;
};

/** A session's work over all of its days: WorkRow's counts, and its minutes with activity (a quarter hour with any counts 15). */
export type SessionWork = Omit<WorkRow, "day" | "quarters"> & { minutes: number };

export type ProjectActivity = {
  tool: Tool;
  /** The project's folder, with the home folder as ~ and forward slashes. */
  path: string;
  name: string;
  /** The git branch of the latest session, when the CLI recorded one. */
  branch: string | null;
  lastActive: number;
  sessions: number;
  rows: TokenRow[];
  /** Its days' work; undefined from a computer running AI Cooldown before 0.13, which does not report it. */
  work?: WorkRow[];
};

/** A model's tokens over a whole session. */
export type ModelUsage = Omit<TokenRow, "day">;

/** One Claude Code or Codex session on a computer. */
export type SessionActivity = {
  tool: Tool;
  /** The CLI's own session id (Claude Code) or thread id (Codex). */
  id: string;
  /** Its project folder, as in ProjectActivity. */
  path: string;
  /** Its title, or else its first prompt; only from a computer that shares session content. */
  title: string | null;
  branch: string | null;
  /** Where it ran, as the CLI records it: "cli", "claude-desktop", "vscode", "Codex Desktop", "codex_exec" and so on. */
  source: string | null;
  /** The model its latest reply came from: what continuing it uses unless asked otherwise. */
  model: string | null;
  startedAt: number;
  lastActive: number;
  usage: ModelUsage[];
  /** Subagents it started (Claude Code), each with a transcript of its own. */
  subagents: number;
  /** What it did, its subagents included; undefined from a computer before 0.13. */
  work?: SessionWork;
  /**
   * What has the conversation open on the computer right now, when that takes
   * messages from AI Cooldown, as Claude Code names it: "claude-desktop" (a chat
   * open in the Claude app), "cli" (a terminal), "claude-vscode" and so on. A
   * message from the website goes into it there. Undefined otherwise, and from a
   * computer before 0.14.
   */
  open?: string;
};

export type DeviceActivity = {
  scannedAt: number;
  /** How many days back the rows reach. */
  days: number;
  projects: ProjectActivity[];
  /** The sessions of those days, most recently active first. */
  sessions: SessionActivity[];
};

/** A session counts as live while it wrote to its log this recently. */
export const ACTIVE_MS = 5 * 60_000;

export type Totals = { tokens: number; input: number; output: number; cache: number; messages: number; cost: number; unpriced: string[] };

export const EMPTY_TOTALS: Totals = { tokens: 0, input: 0, output: 0, cache: 0, messages: 0, cost: 0, unpriced: [] };

/** Everything the model read and wrote, cache included: what the API would bill for. */
export const rowTokens = (r: ModelUsage) => r.input + r.output + r.cacheWrite + r.cacheRead;

export function sumRows(rows: ModelUsage[]): Totals {
  const t = { ...EMPTY_TOTALS, unpriced: [] as string[] };
  for (const r of rows) {
    t.tokens += rowTokens(r);
    t.input += r.input;
    t.output += r.output;
    t.cache += r.cacheWrite + r.cacheRead;
    t.messages += r.messages;
    const cost = costOf(r);
    if (cost !== null) t.cost += cost;
    else if (rowTokens(r) > 0 && !t.unpriced.includes(r.model)) t.unpriced.push(r.model);
  }
  return t;
}

/** A local date as YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The `count` days ending today, oldest first. */
export function lastDays(count: number, now: number): string[] {
  const days: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // midday: stepping by 24h never skips a day across DST changes
  for (let i = count - 1; i >= 0; i--) days.push(dayKey(d.getTime() - i * 86400_000));
  return days;
}

/** The rows of these projects from `since` (a day key) on. */
export function rowsSince(projects: ProjectActivity[], since: string): TokenRow[] {
  return projects.flatMap((p) => p.rows.filter((r) => r.day >= since));
}

export const NO_QUARTERS: Quarters = "0".repeat(24);

export const QUARTERS_RE = /^[0-9a-f]{24}$/;

/** The quarter hour of the local day `ms` falls in: 0 for 00:00-00:15, 95 for 23:45-24:00. */
export function quarterOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15);
}

/** `quarters` with quarter `q` set. */
export function withQuarter(quarters: Quarters, q: number): Quarters {
  const i = q >> 2;
  return quarters.slice(0, i) + (parseInt(quarters[i], 16) | (8 >> (q & 3))).toString(16) + quarters.slice(i + 1);
}

/** The quarters set in either. */
export function orQuarters(a: Quarters, b: Quarters): Quarters {
  let out = "";
  for (let i = 0; i < 24; i++) out += (parseInt(a[i], 16) | parseInt(b[i], 16)).toString(16);
  return out;
}

const BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** How many quarters of each hour are set, 0 to 4. */
export const quartersByHour = (quarters: Quarters): number[] => [...quarters].map((digit) => BITS[parseInt(digit, 16)]);

/** How many quarters are set. */
export const countQuarters = (quarters: Quarters): number => quartersByHour(quarters).reduce((n, q) => n + q, 0);

/** "1.2M", "84k", "950". */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
