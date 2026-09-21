"use client";

import { useState } from "react";
import { formatCountdown, formatDateTime } from "@/lib/format";
import type { Sample } from "@/lib/history";
import { burnFor, dailyBudgetFor, paceFor } from "@/lib/stats";
import type { UsageWindow } from "@/lib/types";
import { useAnimatedNumber } from "@/lib/use-animated-number";
import { HistoryChart } from "./HistoryChart";
import { Icon } from "./Icon";
import { Sparkline } from "./Sparkline";

type Props = { window: UsageWindow; samples: Sample[]; now: number; accent: string };

type Chip = { icon: Parameters<typeof Icon>[0]["name"]; text: string; tone?: "good" | "warn" | "bad"; title?: string };

/**
 * One limit window: a big "left" number, a rounded meter with a pace marker
 * (fill left of the marker = under pace), and chips for reset, pace, burn and
 * budget. Click to open the 48-hour history.
 */
export function WindowRow({ window: w, samples, now, accent }: Props) {
  const [open, setOpen] = useState(false);
  const shownUsed = useAnimatedNumber(w.usedPercent);
  const used = Math.round(w.usedPercent);
  const left = 100 - used;
  const pace = paceFor(w, now);
  const burn = burnFor(w, samples, now);
  const budget = dailyBudgetFor(w, samples, now);
  const resetMs = w.resetsAt ? new Date(w.resetsAt).getTime() - now : null;
  const critical = used >= 90;
  const fill = critical ? "#f43f5e" : accent;

  const chips: Chip[] = [];
  if (resetMs === null) chips.push({ icon: "clock", text: "no reset time" });
  else if (resetMs <= 0) chips.push({ icon: "clock", text: "reset due" });
  else chips.push({ icon: "clock", text: formatCountdown(resetMs), title: `Resets ${formatDateTime(w.resetsAt!, now)}` });
  if (pace)
    chips.push({
      icon: "gauge",
      text: `${pace.label} ${pace.deltaPct >= 0 ? "+" : ""}${Math.round(pace.deltaPct)}`,
      tone: pace.label === "above pace" ? "warn" : pace.label === "below pace" ? "good" : undefined,
      title: `${Math.round(pace.elapsedPct)}% of the window has elapsed, ${used}% of the quota is used`,
    });
  if (burn && burn.perHour > 0 && burn.emptyAt !== null) {
    chips.push({
      icon: "flame",
      text: `${burn.perHour.toFixed(burn.perHour < 10 ? 1 : 0)}%/h · empty ~${formatCountdown(burn.emptyAt - now)}`,
      tone: burn.beforeReset ? "bad" : burn.beforeReset === false ? "good" : undefined,
      title: burn.beforeReset ? "At this pace you run out before the reset" : burn.beforeReset === false ? "At this pace you last until the reset" : "Projection from the last 90 minutes",
    });
  }
  if (budget && left > 0) {
    const today = budget.todayUsed === null ? "" : ` · today ${Math.round(budget.todayUsed)}%`;
    const tone =
      budget.todayUsed === null ? undefined : budget.todayUsed > budget.perDay * 1.2 ? "warn" : budget.todayUsed < budget.perDay * 0.8 ? "good" : undefined;
    chips.push({
      icon: "calendar",
      text: `${budget.perDay < 9.95 ? budget.perDay.toFixed(1) : Math.round(budget.perDay)}%/day${today}`,
      tone,
      title: "What you can spend per day and still reach the reset, next to what you spent since midnight",
    });
  }

  return (
    <div className="py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group block w-full rounded-lg text-left"
        title={open ? "Hide history" : "Show 48-hour history"}
      >
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="chevron" size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""} group-hover:text-fg`} />
            <span className="truncate text-sm font-medium text-fg-2 group-hover:text-fg">{w.label}</span>
            {w.isActive && <span className="chip chip-bad shrink-0">limiting</span>}
          </div>
          <div className="flex shrink-0 items-baseline gap-1">
            <span className={`font-mono text-xl font-semibold tabular-nums ${critical ? "text-rose-600 dark:text-rose-300" : left <= 30 ? "text-amber-600 dark:text-amber-200" : "text-fg"}`}>
              {Math.round(100 - shownUsed)}%
            </span>
            <span className="text-xs text-muted">left</span>
          </div>
        </div>

        <div className="relative mt-2 h-2 w-full rounded-full bg-track" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={100} aria-label={`${w.label}: ${used}% used`}>
          <div className="h-full rounded-full" style={{ width: `${shownUsed}%`, background: fill }} />
          {pace && (
            <div
              className="absolute -top-1.5 h-0 w-0 -translate-x-1/2 border-x-[4px] border-t-[5px] border-x-transparent border-t-fg-2"
              style={{ left: `${pace.elapsedPct}%` }}
              title={`${Math.round(pace.elapsedPct)}% of the window has elapsed. Fill left of this marker means you are under pace.`}
            />
          )}
        </div>

        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {chips.map((c, i) => (
              <span key={i} className={`chip ${c.tone ? `chip-${c.tone}` : ""}`} title={c.title}>
                <Icon name={c.icon} size={11} />
                {c.text}
              </span>
            ))}
          </div>
          {!open && (
            <div className="hidden shrink-0 min-[400px]:block">
              <Sparkline samples={samples} color={fill} width={72} />
            </div>
          )}
        </div>
      </button>
      {open && <HistoryChart samples={samples} window={w} burn={burn} color={fill} now={now} />}
    </div>
  );
}
