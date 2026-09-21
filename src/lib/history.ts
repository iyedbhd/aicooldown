import type { Usage } from "./types";

/** [epoch ms, percent used] */
export type Sample = [number, number];
/** accountId → window key → samples, oldest first. */
export type History = Record<string, Record<string, Sample[]>>;

const KEY = "ai-usage-tracker:history";
const MAX_AGE_MS = 48 * 3600_000;
const MIN_GAP_MS = 60_000;
const MAX_POINTS = 600;

export function loadHistory(): History {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as History) : {};
  } catch {
    return {};
  }
}

function save(history: History): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    /* quota exceeded or storage unavailable: history is a nice-to-have */
  }
}

/** Appends one sample per window and returns a new History object. */
export function recordSamples(history: History, accountId: string, usage: Usage, at = Date.now()): History {
  const cutoff = at - MAX_AGE_MS;
  const forAccount = { ...(history[accountId] ?? {}) };
  for (const w of usage.windows) {
    const prev = (forAccount[w.key] ?? []).filter(([t]) => t >= cutoff);
    const last = prev[prev.length - 1];
    if (last && at - last[0] < MIN_GAP_MS) continue;
    const sample: Sample = [at, w.usedPercent];
    forAccount[w.key] = [...prev, sample].slice(-MAX_POINTS);
  }
  const next = { ...history, [accountId]: forAccount };
  save(next);
  return next;
}

export function dropHistory(history: History, accountId: string): History {
  const next = { ...history };
  delete next[accountId];
  save(next);
  return next;
}
