import type { Sample } from "./history";
import type { Account, Provider, Usage, UsageWindow } from "./types";

const SESSION_KEYS = new Set(["five_hour", "primary"]);

/** Codex calls whichever window comes first "primary", so a reported length outranks the key. */
export function isSessionWindow(w: UsageWindow): boolean {
  if (w.windowSeconds) return w.windowSeconds <= 5 * 3600;
  return SESSION_KEYS.has(w.key);
}

export type Pace = {
  /** How far through the window we are, 0–100. */
  elapsedPct: number;
  /** usedPercent minus elapsedPct. Positive = consuming faster than time passes. */
  deltaPct: number;
  label: "above pace" | "on pace" | "below pace";
};

/** Compares usage to the share of the window that has already elapsed. */
export function paceFor(w: UsageWindow, now: number): Pace | null {
  if (!w.resetsAt || !w.windowSeconds) return null;
  const remainingMs = new Date(w.resetsAt).getTime() - now;
  const elapsedPct = Math.max(0, Math.min(100, (1 - remainingMs / (w.windowSeconds * 1000)) * 100));
  const deltaPct = w.usedPercent - elapsedPct;
  const label = deltaPct > 10 ? "above pace" : deltaPct < -10 ? "below pace" : "on pace";
  return { elapsedPct, deltaPct, label };
}

export type Burn = {
  /** Percentage points consumed per hour over the recent window (0 when idle). */
  perHour: number;
  /** Projected moment the window hits 100%, or null when idle. */
  emptyAt: number | null;
  /** Whether that moment lands before the window resets; null when unknown. */
  beforeReset: boolean | null;
};

const BURN_LOOKBACK_MS = 90 * 60_000;
const BURN_MIN_SPAN_MS = 10 * 60_000;

/** Recent burn rate from local polling history, and where it leads. */
export function burnFor(w: UsageWindow, samples: Sample[], now: number): Burn | null {
  const recent = samples.filter(([t]) => t >= now - BURN_LOOKBACK_MS);
  if (recent.length < 2) return null;
  const [t0, p0] = recent[0];
  const [t1, p1] = recent[recent.length - 1];
  if (t1 - t0 < BURN_MIN_SPAN_MS) return null;
  const perHour = ((p1 - p0) / (t1 - t0)) * 3600_000;
  if (perHour < 0.5 || w.usedPercent >= 100) return { perHour: 0, emptyAt: null, beforeReset: null };
  const emptyAt = now + ((100 - w.usedPercent) / perHour) * 3600_000;
  const reset = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
  return { perHour, emptyAt, beforeReset: reset === null ? null : emptyAt < reset };
}

export type Ranked = {
  account: Account;
  /** Percent left in the session window, null when the provider reports none. */
  sessionLeft: number | null;
  /** Smallest percent left across weekly / scoped windows. */
  weeklyLeft: number | null;
  /** Earliest reset among windows that are at 100%, null when nothing is exhausted. */
  blockedUntil: number | null;
  /** Length of the window behind `blockedUntil`, for showing how far through the wait we are. */
  blockedWindowMs: number | null;
};

/** Orders accounts by how much immediate headroom they have; exhausted ones last. */
export function rankAccounts(accounts: Account[], usages: Record<string, Usage | undefined>): Record<Provider, Ranked[]> {
  const out: Record<Provider, Ranked[]> = { claude: [], codex: [] };
  for (const account of accounts) {
    const windows = usages[account.id]?.windows ?? [];
    const session = windows.find(isSessionWindow);
    const weekly = windows.filter((w) => !isSessionWindow(w));
    const exhausted = windows
      .filter((w) => w.usedPercent >= 100 && w.resetsAt)
      .sort((a, b) => new Date(a.resetsAt!).getTime() - new Date(b.resetsAt!).getTime());
    const blocking = exhausted[0];
    out[account.provider].push({
      account,
      sessionLeft: session ? 100 - session.usedPercent : null,
      weeklyLeft: weekly.length ? Math.min(...weekly.map((w) => 100 - w.usedPercent)) : null,
      blockedUntil: blocking ? new Date(blocking.resetsAt!).getTime() : null,
      blockedWindowMs: blocking?.windowSeconds ? blocking.windowSeconds * 1000 : null,
    });
  }
  const score = (r: Ranked) => (r.blockedUntil ? -1 : Math.min(r.sessionLeft ?? 100, r.weeklyLeft ?? 100));
  for (const list of Object.values(out)) {
    list.sort((a, b) => score(b) - score(a) || (b.weeklyLeft ?? 0) - (a.weeklyLeft ?? 0));
  }
  return out;
}

export type Verdict =
  | { kind: "unknown" }
  | { kind: "go"; account: Account; sessionLeft: number | null; weeklyLeft: number | null }
  | { kind: "wait"; account: Account; waitMs: number; windowMs: number | null };

/** The one-line answer per provider: go with this account, or wait this long. */
export function providerVerdict(list: Ranked[], now: number): Verdict {
  const withData = list.filter((r) => r.sessionLeft !== null || r.weeklyLeft !== null);
  if (withData.length === 0) return { kind: "unknown" };
  const best = withData.find((r) => !r.blockedUntil);
  if (best) return { kind: "go", account: best.account, sessionLeft: best.sessionLeft, weeklyLeft: best.weeklyLeft };
  const soonest = withData.reduce((a, b) => (b.blockedUntil! < a.blockedUntil! ? b : a));
  return { kind: "wait", account: soonest.account, waitMs: soonest.blockedUntil! - now, windowMs: soonest.blockedWindowMs };
}

export type DailyBudget = {
  /** Percent per day you can spend and still reach the reset. */
  perDay: number;
  /** Percent spent since local midnight, when history reaches back that far. */
  todayUsed: number | null;
  daysLeft: number;
};

/** For multi-day windows: how much of the remaining quota fits in each day. */
export function dailyBudgetFor(w: UsageWindow, samples: Sample[], now: number): DailyBudget | null {
  if (!w.resetsAt || !w.windowSeconds || w.windowSeconds < 2 * 86400) return null;
  const remainingMs = new Date(w.resetsAt).getTime() - now;
  if (remainingMs <= 0) return null;
  const daysLeft = remainingMs / 86400_000;
  const left = 100 - w.usedPercent;
  const perDay = daysLeft >= 1 ? left / daysLeft : left;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const atMidnight = [...samples].reverse().find(([t]) => t <= midnight.getTime());
  const todayUsed = atMidnight ? Math.max(0, w.usedPercent - atMidnight[1]) : null;
  return { perDay, todayUsed, daysLeft };
}

export type ResetEvent = { account: Account; window: UsageWindow; at: number };

export function upcomingResets(accounts: Account[], usages: Record<string, Usage | undefined>, now: number): ResetEvent[] {
  return accounts
    .flatMap((account) =>
      (usages[account.id]?.windows ?? [])
        .filter((w) => w.resetsAt)
        .map((window) => ({ account, window, at: new Date(window.resetsAt!).getTime() })),
    )
    .filter((e) => e.at > now)
    .sort((a, b) => a.at - b.at);
}
