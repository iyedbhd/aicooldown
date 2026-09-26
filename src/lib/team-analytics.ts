import { countQuarters, dayKey, formatTokens, NO_QUARTERS, orQuarters, quartersByHour, rowTokens, type Quarters, type SessionActivity, type Tool } from "./activity";
import { formatMoney } from "./format";
import { costOf } from "./pricing";
import { monthlyPrice } from "./spend";
import { projectName, type Member, type Workspace } from "./team";
import type { Series } from "./team-stats";

/*
 * What the Analytics tab adds up from a workspace, per person and day: the
 * tokens their computers' Claude Code and Codex used and what that is worth
 * at API prices, the sessions they started, and, from computers running AI
 * Cooldown 0.13 or later, the prompts they typed, the files and lines the
 * CLIs changed, the commands they ran, and the quarter hours with any of it.
 * Only the people whose work the viewer sees: themselves, or everyone for a
 * team's owners and admins (of an owner or admin, what they share).
 */

/** How far back computers report: the most a period and the one before it can reach together. */
export const HISTORY_DAYS = 30;

/** A computer reports its sessions up to this many; past it, the oldest are missing. */
const MAX_REPORTED_SESSIONS = 300;

export type Measure = "tokens" | "value" | "sessions" | "prompts" | "lines" | "active";

export const MEASURES: { id: Measure; label: string; noun: string; help: string; work: boolean }[] = [
  { id: "tokens", label: "Tokens", noun: "tokens", help: "Every token Claude Code and Codex read and wrote, cache included", work: false },
  { id: "value", label: "API value", noun: "API value", help: "What those tokens would cost at Anthropic's and OpenAI's API list prices; subscriptions do not bill per token", work: false },
  { id: "sessions", label: "Sessions", noun: "sessions", help: "Claude Code and Codex sessions started", work: false },
  { id: "prompts", label: "Prompts", noun: "prompts", help: "Prompts people typed, not the CLIs' own messages or the tasks sessions give their subagents", work: true },
  { id: "lines", label: "Lines changed", noun: "lines changed", help: "Lines Claude Code and Codex added and removed in files, from the edits and patches they made", work: true },
  { id: "active", label: "Active time", noun: "active time", help: "Quarter hours with any prompt, reply, command or change, each counting 15 minutes; not working hours", work: true },
];

/** One person's numbers on one day (or over several: see Totals). */
type Counts = {
  tokens: number;
  /** What the models read: input, cache writes and cache reads. */
  read: number;
  cacheRead: number;
  replies: number;
  value: number;
  sessions: number;
  /** Of those, the ones on computers that report work: what prompts per session is over. */
  workSessions: number;
  prompts: number;
  edits: number;
  added: number;
  removed: number;
  commands: number;
};

export type Day = Counts & {
  /** Across all of their computers and projects. */
  quarters: Quarters;
  /** Models with no known price. */
  unpriced: string[];
};

export type Totals = Counts & { hours: number; activeDays: number; unpriced: string[] };

const zero = (): Counts => ({ tokens: 0, read: 0, cacheRead: 0, replies: 0, value: 0, sessions: 0, workSessions: 0, prompts: 0, edits: 0, added: 0, removed: 0, commands: 0 });
const emptyDay = (): Day => ({ ...zero(), quarters: NO_QUARTERS, unpriced: [] });
const COUNTS = Object.keys(zero()) as (keyof Counts)[];

/** A model's tokens and API value by day; null value when it has no known price. */
type ModelDays = { tool: Tool; days: Map<string, { tokens: number; value: number | null }> };

export type PersonStats = {
  member: Member;
  /** The CSS colour of their series. */
  color: string;
  /** Whether their series stands alone: with more than eight people, the eighth on share "Others". */
  own: boolean;
  days: Map<string, Day>;
  /** The same by project name. */
  projects: Map<string, Map<string, Day>>;
  models: Map<string, ModelDays>;
  /** Their computers with any activity, and the names of those that do not report work (prompts, lines, active time). */
  computers: number;
  outdated: string[];
  /** Whether a computer of theirs reports as many sessions as it may, so older ones are missing. */
  capped: boolean;
  /** List prices of their linked accounts' plans, USD per month. */
  plans: number;
};

/** The categorical series colours (globals.css), in the order people get them. */
const SLOTS = 8;
export const OTHERS_COLOR = "var(--series-other)";
const slotColor = (i: number) => `var(--series-${i + 1})`;

/** "claude-opus-4-5-20251101" → "claude-opus-4-5": a model without its snapshot date. */
export const modelName = (model: string) => model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");

function add(into: Day, row: Partial<Counts> & { quarters?: Quarters; unpriced?: string[] }): void {
  for (const k of COUNTS) into[k] += row[k] ?? 0;
  if (row.quarters) into.quarters = orQuarters(into.quarters, row.quarters);
  for (const m of row.unpriced ?? []) if (!into.unpriced.includes(m)) into.unpriced.push(m);
}

/** A session that did something in its own log: a chat copied from another (to another account, or forked) holds nothing of its own until it is continued. */
const worked = (s: SessionActivity) => s.startedAt > 0 && s.usage.some((u) => rowTokens(u) > 0);

const at = <K>(map: Map<K, Day>, key: K): Day => {
  let d = map.get(key);
  if (!d) map.set(key, (d = emptyDay()));
  return d;
};

/**
 * Everyone the viewer sees the work of, with their days. Colours follow the
 * roster among those with a computer, so a person keeps theirs whatever the
 * period or filter; with more than eight people, the eighth on are "Others".
 */
export function peopleStats(ws: Workspace): PersonStats[] {
  const people = ws.members.filter((m) => m.detailed);
  const working = people.filter((m) => m.devices.some((d) => d.activity));
  return people.map((member) => {
    const index = working.indexOf(member);
    const own = index >= 0 && (working.length <= SLOTS || index < SLOTS - 1);
    const stats: PersonStats = {
      member,
      color: own ? slotColor(index) : OTHERS_COLOR,
      own,
      days: new Map(),
      projects: new Map(),
      models: new Map(),
      computers: 0,
      outdated: [],
      capped: false,
      plans: member.accounts.reduce((n, a) => n + (monthlyPrice(a.provider, a.plan ?? a.usage?.plan) ?? 0), 0),
    };
    for (const device of member.devices) {
      const activity = device.activity;
      if (!activity || (activity.projects.length === 0 && activity.sessions.length === 0)) continue;
      stats.computers += 1;
      const works = activity.projects.some((p) => p.work);
      if (!works) stats.outdated.push(device.name);
      if (activity.sessions.length >= MAX_REPORTED_SESSIONS) stats.capped = true;
      for (const project of activity.projects) {
        const byDay = stats.projects.get(project.name) ?? new Map<string, Day>();
        stats.projects.set(project.name, byDay);
        for (const r of project.rows) {
          const cost = costOf(r);
          const counts = { tokens: rowTokens(r), read: r.input + r.cacheWrite + r.cacheRead, cacheRead: r.cacheRead, replies: r.messages, value: cost ?? 0, unpriced: cost === null && rowTokens(r) > 0 ? [r.model] : [] };
          add(at(stats.days, r.day), counts);
          add(at(byDay, r.day), counts);
          const name = modelName(r.model);
          const model = stats.models.get(name) ?? { tool: project.tool, days: new Map() };
          stats.models.set(name, model);
          const m = model.days.get(r.day) ?? { tokens: 0, value: 0 };
          m.tokens += counts.tokens;
          m.value = m.value === null || cost === null ? null : m.value + cost;
          model.days.set(r.day, m);
        }
        for (const w of project.work ?? []) {
          add(at(stats.days, w.day), w);
          add(at(byDay, w.day), w);
        }
      }
      for (const s of activity.sessions) {
        if (!worked(s)) continue;
        const day = dayKey(s.startedAt);
        const started = { sessions: 1, workSessions: works ? 1 : 0 };
        add(at(stats.days, day), started);
        const name = projectName(activity, s.tool, s.path);
        const byDay = stats.projects.get(name) ?? new Map<string, Day>();
        stats.projects.set(name, byDay);
        add(at(byDay, day), started);
      }
    }
    return stats;
  });
}

/** A measure's value on a day: hours for active time. */
export function measureOf(d: Day | undefined, m: Measure): number {
  if (!d) return 0;
  switch (m) {
    case "tokens":
      return d.tokens;
    case "value":
      return d.value;
    case "sessions":
      return d.sessions;
    case "prompts":
      return d.prompts;
    case "lines":
      return d.added + d.removed;
    case "active":
      return countQuarters(d.quarters) / 4;
  }
}

const busy = (d: Day) => d.tokens > 0 || d.sessions > 0 || d.prompts > 0 || d.edits > 0;

/** Someone's numbers over `days`. */
export function totalsOver(days: Map<string, Day>, over: string[]): Totals {
  const t: Totals = { ...zero(), hours: 0, activeDays: 0, unpriced: [] };
  for (const day of over) {
    const d = days.get(day);
    if (!d) continue;
    for (const k of COUNTS) t[k] += d[k];
    t.hours += countQuarters(d.quarters) / 4;
    if (busy(d)) t.activeDays += 1;
    for (const m of d.unpriced) if (!t.unpriced.includes(m)) t.unpriced.push(m);
  }
  return t;
}

export function sumTotals(list: Totals[]): Totals {
  const t: Totals = { ...zero(), hours: 0, activeDays: 0, unpriced: [] };
  for (const x of list) {
    for (const k of COUNTS) t[k] += x[k];
    t.hours += x.hours;
    t.activeDays += x.activeDays;
    for (const m of x.unpriced) if (!t.unpriced.includes(m)) t.unpriced.push(m);
  }
  return t;
}

export function measureTotal(t: Totals, m: Measure): number {
  switch (m) {
    case "lines":
      return t.added + t.removed;
    case "active":
      return t.hours;
    default:
      return t[m];
  }
}

/** One series per person with a colour of their own, the rest summed as Others; people with nothing in the period left out. */
export function daySeries(people: PersonStats[], days: string[], m: Measure): Series[] {
  const series: Series[] = [];
  let others: Series | null = null;
  for (const p of people) {
    const values = days.map((d) => measureOf(p.days.get(d), m));
    if (!values.some((v) => v > 0)) continue;
    if (p.own) series.push({ key: p.member.id, label: p.member.email, color: p.color, values });
    else {
      others ??= { key: "others", label: "Others", color: OTHERS_COLOR, values: days.map(() => 0) };
      values.forEach((v, i) => (others!.values[i] += v));
    }
  }
  return others ? [...series, others] : series;
}

/** The ratio of a period's value to the one before, as a change: +0.25 is a quarter more. Null without a base to compare with. */
export const change = (now: number, before: number): number | null => (before > 0 ? now / before - 1 : null);

/** When the work happened: per weekday (Monday first) and hour, in each computer's own time. */
export type WeekHours = {
  /** Active quarter hours from computers that report them, or else sessions started (in this browser's time). */
  kind: "active" | "starts";
  /** [weekday][hour]: hours of activity, or sessions. */
  cells: number[][];
  max: number;
};

const weekday = (day: string) => (new Date(`${day}T12:00:00`).getDay() + 6) % 7;

export function weekHours(people: PersonStats[], days: string[]): WeekHours {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let active = false;
  for (const p of people) {
    for (const day of days) {
      const d = p.days.get(day);
      if (!d || d.quarters === NO_QUARTERS) continue;
      active = true;
      quartersByHour(d.quarters).forEach((q, h) => (cells[weekday(day)][h] += q / 4));
    }
  }
  if (!active) {
    const wanted = new Set(days);
    for (const p of people) {
      for (const device of p.member.devices) {
        for (const s of device.activity?.sessions ?? []) {
          if (!worked(s) || !wanted.has(dayKey(s.startedAt))) continue;
          const t = new Date(s.startedAt);
          cells[(t.getDay() + 6) % 7][t.getHours()] += 1;
        }
      }
    }
  }
  return { kind: active ? "active" : "starts", cells, max: Math.max(0, ...cells.flat()) };
}

/** A project's value of a measure, by person (Others summed). */
export type ProjectBar = { name: string; total: number; parts: { key: string; label: string; color: string; value: number }[] };

/** The busiest projects by `m` over `days`, split by person. */
export function projectBars(people: PersonStats[], days: string[], m: Measure, limit: number): ProjectBar[] {
  const bars = new Map<string, ProjectBar>();
  for (const p of people) {
    for (const [name, byDay] of p.projects) {
      const value = days.reduce((n, d) => n + measureOf(byDay.get(d), m), 0);
      if (value <= 0) continue;
      const bar = bars.get(name) ?? { name, total: 0, parts: [] };
      bars.set(name, bar);
      bar.total += value;
      const key = p.own ? p.member.id : "others";
      const part = bar.parts.find((x) => x.key === key);
      if (part) part.value += value;
      else bar.parts.push({ key, label: p.own ? p.member.email : "Others", color: p.color, value });
    }
  }
  // Parts in the same order as the people, so a stack reads the same in every bar.
  const order = [...people.filter((p) => p.own).map((p) => p.member.id), "others"];
  return [...bars.values()]
    .map((b) => ({ ...b, parts: b.parts.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export type ModelShare = { model: string; tool: Tool; tokens: number; value: number | null };

/** Tokens and API value by model over `days`, most used first. */
export function modelShares(people: PersonStats[], days: string[]): ModelShare[] {
  const shares = new Map<string, ModelShare>();
  for (const p of people) {
    for (const [model, usage] of p.models) {
      const s = shares.get(model) ?? { model, tool: usage.tool, tokens: 0, value: 0 };
      for (const day of days) {
        const d = usage.days.get(day);
        if (!d) continue;
        s.tokens += d.tokens;
        s.value = s.value === null || d.value === null ? null : s.value + d.value;
      }
      if (s.tokens > 0) shares.set(model, s);
    }
  }
  return [...shares.values()].sort((a, b) => b.tokens - a.tokens);
}

/** Hours as people say them: "45 min", "3.5 h", "120 h". */
export function formatHours(h: number): string {
  if (h <= 0) return "0 h";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`;
}

/** A count: exact up to 10,000, then "12k", "1.2M". */
export const formatCount = (n: number) => (n < 10_000 ? Math.round(n).toLocaleString() : formatTokens(n));

export function formatMeasure(m: Measure, v: number): string {
  switch (m) {
    case "tokens":
      return formatTokens(v);
    case "value":
      return formatMoney(v);
    case "active":
      return formatHours(v);
    default:
      return formatCount(v);
  }
}

/** A measure's value with what it counts: "1.2M tokens", "$12", "40 prompts", "3.5 h". */
export function describeMeasure(m: Measure, v: number): string {
  const n = formatMeasure(m, v);
  switch (m) {
    case "tokens":
      return `${n} tokens`;
    case "sessions":
      return `${n} session${v === 1 ? "" : "s"}`;
    case "prompts":
      return `${n} prompt${v === 1 ? "" : "s"}`;
    case "lines":
      return `${n} line${v === 1 ? "" : "s"}`;
    default:
      return n;
  }
}
