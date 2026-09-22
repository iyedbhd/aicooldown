"use client";

import { useState } from "react";
import { formatCountdown, formatDateTime } from "@/lib/format";
import { isSessionWindow, type ResetEvent } from "@/lib/stats";
import type { Account, UsageWindow } from "@/lib/types";
import { ProviderGlyph } from "./ProviderLogo";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const RANGES = [
  { label: "1 day", ms: DAY, tickHours: 2 },
  { label: "3 days", ms: 3 * DAY, tickHours: 4 },
  { label: "7 days", ms: 7 * DAY, tickHours: 12 },
] as const;
/** Resets closer together than this share one pill (weekly and Fable reset at the same instant). */
const MERGE_MS = 60_000;
const LABEL_COL = "10rem";
const ROW = "h-9";

/** "5h", "week", "Fable": short enough to fit on a pill. */
function shortLabel(w: UsageWindow): string {
  if (isSessionWindow(w)) return "5h";
  if (w.key === "seven_day" || /^Weekly$/i.test(w.label)) return "week";
  const scoped = w.label.match(/^Weekly · (.+)$/) ?? w.label.match(/^(.+) · Weekly$/);
  return scoped ? scoped[1] : w.label;
}

type Pill = { at: number; events: ResetEvent[]; exhausted: boolean; session: boolean };

function pillsFor(events: ResetEvent[]): Pill[] {
  const pills: Pill[] = [];
  for (const e of events) {
    const last = pills[pills.length - 1];
    if (last && e.at - last.at < MERGE_MS) {
      last.events.push(e);
      last.exhausted ||= e.window.usedPercent >= 100;
      last.session &&= isSessionWindow(e.window);
    } else {
      pills.push({ at: e.at, events: [e], exhausted: e.window.usedPercent >= 100, session: isSessionWindow(e.window) });
    }
  }
  return pills;
}

function pillClass(p: Pill): string {
  if (p.exhausted) return "bg-rose-600 text-white";
  if (p.session) return "bg-amber-600 text-white";
  return "bg-violet-600 text-white";
}

type Tick = { at: number; day: boolean; label: string };

/** Local midnights get a date label; the hours between them get a two-digit hour. */
function ticksFor(now: number, rangeMs: number, tickHours: number): Tick[] {
  const ticks: Tick[] = [];
  const t = new Date(now);
  t.setMinutes(0, 0, 0);
  for (let d = new Date(t.getTime() + HOUR); d.getTime() < now + rangeMs; d = new Date(d.getTime() + HOUR)) {
    const h = d.getHours();
    if (h === 0) ticks.push({ at: d.getTime(), day: true, label: d.toLocaleDateString(undefined, { day: "numeric", weekday: "short" }) });
    else if (h % tickHours === 0) ticks.push({ at: d.getTime(), day: false, label: String(h).padStart(2, "0") });
  }
  return ticks;
}

function describe(e: ResetEvent, now: number): string {
  const at100 = e.window.usedPercent >= 100 ? " · at 100" : "";
  return `${e.window.label} · in ${formatCountdown(e.at - now)} (${formatDateTime(e.window.resetsAt!, now)})${at100}`;
}

type Props = { accounts: Account[]; events: ResetEvent[]; now: number };

/** One row per account on a linear clock: pills sit where each limit comes back. */
export function ResetTimeline({ accounts, events, now }: Props) {
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = RANGES[rangeIdx];
  const pct = (at: number) => Math.round(((at - now) / range.ms) * 100_000) / 1000;
  const ticks = ticksFor(now, range.ms, range.tickHours);
  const nowLabel = new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const rows = accounts.map((account) => {
    const mine = events.filter((e) => e.account.id === account.id);
    return { account, pills: pillsFor(mine.filter((e) => e.at < now + range.ms)), later: mine.filter((e) => e.at >= now + range.ms) };
  });

  return (
    <div className="fade-in rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">Where each limit comes back, on the clock</span>
        <div className="flex gap-1" role="group" aria-label="Timeline range">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRangeIdx(i)}
              aria-pressed={i === rangeIdx}
              className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${i === rangeIdx ? "bg-fg text-bg" : "bg-panel-3 text-muted hover:text-fg"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `${LABEL_COL} 1fr` }}>
          {/* Left column: header, then one label per account. */}
          <div>
            <div className={`${ROW} flex items-end pb-1 pr-3 text-[10px] uppercase tracking-wide text-faint`}>account</div>
            {rows.map(({ account }) => (
              <div key={account.id} className={`${ROW} flex items-center gap-2 border-t border-line pr-3`}>
                <ProviderGlyph provider={account.provider} size={12} className="shrink-0 opacity-90" />
                <span className="truncate text-xs text-fg-2">{account.label}</span>
              </div>
            ))}
          </div>

          {/* Right column: the clock. The overlay draws ticks and the now line through every row. */}
          <div className="relative">
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {ticks.map((t) => (
                <div key={t.at} className="absolute top-0 bottom-0" style={{ left: `${pct(t.at)}%` }}>
                  <div className={`absolute top-6 bottom-0 border-l ${t.day ? "border-line" : "border-line/40"}`} />
                  <span
                    className={`absolute whitespace-nowrap font-mono tabular-nums ${t.day ? "top-1 text-[11px] text-fg-2" : "top-4 text-[9px] text-faint"}`}
                    style={{ transform: "translateX(2px)" }}
                  >
                    {t.label}
                  </span>
                </div>
              ))}
              <div className="absolute top-2 bottom-0 border-l-2 border-emerald-500" style={{ left: 0 }}>
                <span className="absolute top-0 -translate-y-1/2 -translate-x-1 whitespace-nowrap rounded bg-emerald-600 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white">
                  now {nowLabel}
                </span>
              </div>
            </div>

            <div className={ROW} />
            {rows.map(({ account, pills, later }) => (
              <div key={account.id} className={`${ROW} relative border-t border-line`}>
                {pills.map((p) => {
                  const left = pct(p.at);
                  return (
                    <span
                      key={p.at}
                      title={[account.label, ...p.events.map((e) => describe(e, now))].join("\n")}
                      className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${pillClass(p)} ${left > 88 ? "-translate-x-full" : ""}`}
                      style={{ left: `${left}%`, transition: "left 1s linear" }}
                    >
                      {p.events.map((e) => shortLabel(e.window)).join("+")}
                    </span>
                  );
                })}
                {later.length > 0 && (
                  <span
                    title={later.map((e) => describe(e, now)).join("\n")}
                    className="absolute top-1/2 right-0 -translate-y-1/2 font-mono text-[10px] text-faint"
                  >
                    +{later.length} later ›
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-faint">
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-amber-600 px-1.5 py-0.5 text-white">5h</span>5 hour limit resets
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-violet-600 px-1.5 py-0.5 text-white">week+Fable</span>weekly and per-model limits reset (they share one instant)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-rose-600 px-1.5 py-0.5 text-white">week+Fable</span>a limit at 100 comes back
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 border-l-2 border-emerald-500" />now
        </span>
        {events.length === 0 && <span>No reset times reported yet.</span>}
      </div>
    </div>
  );
}
