"use client";

import { useEffect, useRef, useState } from "react";
import type { Series } from "@/lib/team-stats";

/*
 * A value per day as columns, series stacked from the bottom in their order,
 * with a legend (each series' total), a readout per day on hover or focus,
 * and the numbers as a table for screen readers.
 */

type Props = {
  days: string[];
  series: Series[];
  /** Axis ticks and the readout's rows. */
  format: (v: number) => string;
  /** The readout's headline: a day's total with what it counts. */
  describe: (total: number) => string;
  /** A line under the readout's rows for day `i`. */
  note?: (i: number) => string | null;
  /** What the chart shows, for screen readers: "Tokens per day". */
  label: string;
  /** What it says when every value is 0. */
  empty: string;
};

const HEIGHT = 170;
const PAD = { top: 10, right: 4, bottom: 22, left: 48 };
const GAP = 2;
const RADIUS = 4;
const TIP_W = 224;

/** 1, 2 or 5 times a power of ten, at least `v`. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((f) => f * step >= v) ?? 10) * step;
}

/** A column segment with its top corners rounded and a square base. */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const dayLabel = (day: string, short: boolean) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, short ? { weekday: "short" } : { month: "short", day: "numeric" });

export function ColumnChart({ days, series, format, describe, note, label, empty: emptyText }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totals = series.map((s) => s.values.reduce((n, v) => n + v, 0));
  const dayTotals = days.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const max = niceCeil(Math.max(0, ...dayTotals));
  const empty = dayTotals.every((v) => v === 0);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = days.length ? plotW / days.length : 0;
  const barW = Math.max(2, Math.min(24, band - GAP));
  const y = (v: number) => (v / max) * plotH;
  const labelEvery = Math.ceil(days.length / 7);
  const short = days.length <= 7;
  const extra = active === null ? null : (note?.(active) ?? null);

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s, i) => (
            <span key={s.key} className="flex min-w-0 max-w-full items-center gap-1.5 text-xs text-fg-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
              <span className="truncate">{s.label}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted">{format(totals[i])}</span>
            </span>
          ))}
        </div>
      )}
      <div ref={box} className="relative" style={{ height: HEIGHT }}>
        {width > 0 && !empty && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${label} over the last ${days.length} days`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH - f * plotH} y2={PAD.top + plotH - f * plotH} className="stroke-line" strokeWidth={1} />
                <text x={PAD.left - 6} y={PAD.top + plotH - f * plotH} dy="0.32em" textAnchor="end" className="fill-muted font-mono text-[10px]">
                  {format(max * f)}
                </text>
              </g>
            ))}
            {days.map((day, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              const heights = series.map((s) => (s.values[i] > 0 ? Math.max(1.5, y(s.values[i])) : 0));
              const top = heights.findLastIndex((h) => h > 0);
              let base = PAD.top + plotH;
              const dim = active !== null && active !== i;
              return (
                <g key={day} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 0.15s" }}>
                  {series.map((s, k) => {
                    const h = heights[k];
                    if (h === 0) return null;
                    const segment = k === top ? topRounded(x, base - h, barW, h) : `M${x},${base}V${base - h}H${x + barW}V${base}Z`;
                    base -= h + GAP; // the surface shows between stacked segments
                    return <path key={s.key} d={segment} fill={s.color} />;
                  })}
                  {i % labelEvery === 0 && (
                    <text x={PAD.left + i * band + band / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[10px]">
                      {dayLabel(day, short)}
                    </text>
                  )}
                  <rect
                    x={PAD.left + i * band}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={`${dayLabel(day, false)}: ${describe(dayTotals[i])}${series.length > 1 ? `, ${series.map((s) => `${s.label} ${format(s.values[i])}`).join(", ")}` : ""}`}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className="outline-none"
                  />
                </g>
              );
            })}
          </svg>
        )}
        {empty && <p className="absolute inset-0 flex items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-sm text-muted">{emptyText}</p>}
        {active !== null && !empty && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-panel px-3 py-2 shadow-lg"
            style={{ width: TIP_W, left: Math.min(Math.max(0, PAD.left + active * band + band / 2 - TIP_W / 2), Math.max(0, width - TIP_W)) }}
          >
            <p className="text-[11px] text-muted">{dayLabel(days[active], false)}</p>
            <p className="font-mono text-sm font-semibold text-fg">{describe(dayTotals[active])}</p>
            {series.length > 1 &&
              series
                .filter((s) => s.values[active] > 0)
                .map((s) => (
                  <p key={s.key} className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-2">
                    <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                    <span className="shrink-0 font-mono">{format(s.values[active])}</span>
                    <span className="truncate text-muted">{s.label}</span>
                  </p>
                ))}
            {extra && <p className="mt-1 font-mono text-[11px] text-muted">{extra}</p>}
          </div>
        )}
      </div>
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th>Day</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => (
              <tr key={day}>
                <td>{day}</td>
                {series.map((s) => (
                  <td key={s.key}>{format(s.values[i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
