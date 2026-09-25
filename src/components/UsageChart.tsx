"use client";

import { useEffect, useRef, useState } from "react";
import { formatTokens, type Tool } from "@/lib/activity";
import { formatMoney } from "@/lib/format";
import type { DayPoint } from "@/lib/team-stats";

/*
 * Tokens per day, Claude Code stacked under Codex. The two hues are the
 * providers' accents (Claude's one step deeper), checked as a pair against
 * both themes' panels for lightness, colour-blind separation and contrast.
 */
const COLOR: Record<Tool, string> = { claude: "#d27252", codex: "#10a37f" };
const NAME: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };
const TOOLS: Tool[] = ["claude", "codex"];
const HEIGHT = 170;
const PAD = { top: 10, right: 4, bottom: 22, left: 44 };
const GAP = 2;
const RADIUS = 4;

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

export function UsageChart({ points }: { points: DayPoint[] }) {
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

  const totals = TOOLS.map((t) => points.reduce((n, p) => n + p[t], 0));
  const max = niceCeil(Math.max(...points.map((p) => p.claude + p.codex)));
  const empty = totals[0] + totals[1] === 0;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = points.length ? plotW / points.length : 0;
  const barW = Math.max(2, Math.min(24, band - GAP));
  const y = (v: number) => (v / max) * plotH;
  const labelEvery = Math.ceil(points.length / 7);
  const short = points.length <= 7;
  const hovered = active === null ? null : points[active];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {TOOLS.map((t, i) => (
          <span key={t} className="flex items-center gap-1.5 text-xs text-fg-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[t] }} aria-hidden />
            {NAME[t]}
            <span className="font-mono text-[11px] text-muted">{formatTokens(totals[i])}</span>
          </span>
        ))}
      </div>
      <div ref={box} className="relative" style={{ height: HEIGHT }}>
        {width > 0 && !empty && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`Tokens per day over the last ${points.length} days`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH - f * plotH} y2={PAD.top + plotH - f * plotH} className="stroke-line" strokeWidth={1} />
                <text x={PAD.left - 6} y={PAD.top + plotH - f * plotH} dy="0.32em" textAnchor="end" className="fill-muted font-mono text-[10px]">
                  {formatTokens(max * f)}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              const base = PAD.top + plotH;
              const hClaude = p.claude > 0 ? Math.max(1.5, y(p.claude)) : 0;
              const hCodex = p.codex > 0 ? Math.max(1.5, y(p.codex)) : 0;
              const codexTop = base - hClaude - (hClaude && hCodex ? GAP : 0) - hCodex;
              const dim = active !== null && active !== i;
              return (
                <g key={p.day} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 0.15s" }}>
                  {hClaude > 0 && <path d={hCodex ? `M${x},${base}V${base - hClaude}H${x + barW}V${base}Z` : topRounded(x, base - hClaude, barW, hClaude)} fill={COLOR.claude} />}
                  {hCodex > 0 && <path d={topRounded(x, codexTop, barW, hCodex)} fill={COLOR.codex} />}
                  {i % labelEvery === 0 && (
                    <text x={PAD.left + i * band + band / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[10px]">
                      {dayLabel(p.day, short)}
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
                    aria-label={`${dayLabel(p.day, false)}: ${formatTokens(p.claude)} Claude Code tokens, ${formatTokens(p.codex)} Codex tokens`}
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
        {empty && <p className="absolute inset-0 flex items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted">No tokens in this period yet.</p>}
        {hovered && active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 rounded-lg border border-line bg-panel px-3 py-2 shadow-lg"
            style={{ left: Math.min(Math.max(0, PAD.left + active * band + band / 2 - 88), Math.max(0, width - 176)) }}
          >
            <p className="text-[11px] text-muted">{dayLabel(hovered.day, false)}</p>
            <p className="font-mono text-sm font-semibold text-fg">{formatTokens(hovered.claude + hovered.codex)} tokens</p>
            {TOOLS.map((t) => (
              <p key={t} className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-2">
                <span className="h-0.5 w-3 rounded-full" style={{ background: COLOR[t] }} aria-hidden />
                <span className="font-mono">{formatTokens(hovered[t])}</span>
                <span className="text-muted">{NAME[t]}</span>
              </p>
            ))}
            {hovered.cost > 0 && <p className="mt-1 font-mono text-[11px] text-muted">≈ {formatMoney(hovered.cost)} at API prices</p>}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Tokens per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Claude Code</th>
            <th>Codex</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <td>{p.day}</td>
              <td>{p.claude}</td>
              <td>{p.codex}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
