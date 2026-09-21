"use client";

import { useId, useRef, useState } from "react";
import { formatCountdown } from "@/lib/format";
import type { Sample } from "@/lib/history";
import type { Burn } from "@/lib/stats";
import type { UsageWindow } from "@/lib/types";

const W = 600;
const H = 210;
const PAD = { l: 30, r: 10, t: 12, b: 22 };
const MIN_SPAN_MS = 60 * 60_000;
const MAX_FUTURE_MS = 6 * 3600_000;

type Props = { samples: Sample[]; window: UsageWindow; burn: Burn | null; color: string; now: number };

/**
 * Usage over the last 48 hours, then a look ahead: a dashed projection at the
 * current burn rate up to the reset (or to empty, if that comes first), with
 * the reset marked. Hover for a readout. Click a window row to open it.
 */
export function HistoryChart({ samples, window: w, burn, color, now }: Props) {
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (samples.length < 2) {
    return (
      <p className="py-3 font-mono text-[11px] text-muted">
        History builds while this page polls. Come back in a few minutes for a chart.
      </p>
    );
  }

  const t0 = Math.min(samples[0][0], now - MIN_SPAN_MS);
  const past = now - t0;
  const resetAt = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
  const resetMs = resetAt !== null ? resetAt - now : null;
  // Look ahead as far as the reset (capped). The future gets a fixed slice of the
  // width with its own time scale, so a short wait still reads at a glance.
  const future = resetMs !== null && resetMs > 0 ? Math.min(resetMs, MAX_FUTURE_MS) : 0;
  const tEnd = now + future;
  const plotW = W - PAD.l - PAD.r;
  const pastW = future > 0 ? plotW * 0.76 : plotW;
  const x = (t: number) => (t <= now || future === 0 ? PAD.l + ((t - t0) / past) * pastW : PAD.l + pastW + ((t - now) / future) * (plotW - pastW));
  const y = (p: number) => PAD.t + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - PAD.t - PAD.b);
  const points = samples.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${x(samples[samples.length - 1][0]).toFixed(1)},${y(0)} L${x(samples[0][0]).toFixed(1)},${y(0)} Z`;
  const resets = samples.filter(([, p], i) => i > 0 && samples[i - 1][1] - p >= 30);
  const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  // Projection from now: climbing at the burn rate until empty or the edge, flat when idle.
  let projection: string | null = null;
  let emptyMark: number | null = null;
  if (future > 0) {
    const used = w.usedPercent;
    if (burn && burn.perHour > 0 && burn.emptyAt !== null) {
      const end = Math.min(burn.emptyAt, tEnd);
      const pEnd = used + (burn.perHour * (end - now)) / 3600_000;
      projection = `M${x(now).toFixed(1)},${y(used).toFixed(1)} L${x(end).toFixed(1)},${y(pEnd).toFixed(1)}`;
      if (burn.emptyAt <= tEnd) emptyMark = burn.emptyAt;
    } else {
      projection = `M${x(now).toFixed(1)},${y(used).toFixed(1)} L${x(tEnd).toFixed(1)},${y(used).toFixed(1)}`;
    }
  }
  const resetInView = resetAt !== null && resetAt <= tEnd && resetAt > now;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    samples.forEach(([t], i) => {
      const d = Math.abs(x(t) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  }

  const h = hover === null ? null : samples[hover];
  const hx = h ? x(h[0]) : 0;
  const hy = h ? y(h[1]) : 0;
  const labelLeft = hx > W * 0.7;
  const mono = "var(--font-mono), monospace";

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 w-full cursor-crosshair select-none"
      role="img"
      aria-label="Usage history and projection"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.3" />
          <stop offset="1" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 50, 100].map((p) => (
        <g key={p}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} className="stroke-line" />
          <text x={PAD.l - 6} y={y(p) + 3} textAnchor="end" fontSize="9" className="fill-muted" fontFamily={mono}>
            {p}
          </text>
        </g>
      ))}
      {future > 0 && <rect x={x(now)} y={PAD.t} width={x(tEnd) - x(now)} height={H - PAD.t - PAD.b} className="fill-fg" fillOpacity="0.025" />}
      {[t0, t0 + past / 2].map((t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor={t === t0 ? "start" : "middle"} fontSize="9" className="fill-muted" fontFamily={mono}>
          {fmtTime(t)}
        </text>
      ))}
      <text x={x(now)} y={H - 6} textAnchor={future > 0 ? "middle" : "end"} fontSize="9" className="fill-muted" fontFamily={mono}>
        now
      </text>
      {resets.map(([t]) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} stroke="#34d399" strokeOpacity=".6" strokeDasharray="2 3" />
          <text x={x(t) + 3} y={PAD.t + 9} fontSize="9" fill="#34d399" fontFamily={mono}>
            reset
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" pathLength={1} className="draw-in" />
      {projection && (
        <>
          <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={H - PAD.b} className="stroke-muted" strokeOpacity="0.5" />
          <path d={projection} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4 4" strokeOpacity="0.8" />
        </>
      )}
      {resetInView && (
        <g>
          <line x1={x(resetAt)} x2={x(resetAt)} y1={PAD.t} y2={H - PAD.b} stroke="#34d399" strokeOpacity=".8" strokeDasharray="2 3" />
          <text x={x(resetAt) - 3} y={H - PAD.b - 4} textAnchor="end" fontSize="9" fill="#34d399" fontFamily={mono}>
            reset in {formatCountdown(resetAt - now)}
          </text>
        </g>
      )}
      {emptyMark !== null && (
        <g>
          <circle cx={x(emptyMark)} cy={y(100)} r="3" fill="#f43f5e" />
          <text x={x(emptyMark) - 5} y={H - PAD.b - 16} textAnchor="end" fontSize="9" fill="#f43f5e" fontFamily={mono}>
            empty in {formatCountdown(emptyMark - now)}
          </text>
        </g>
      )}
      {h && (
        <g>
          <line x1={hx} x2={hx} y1={PAD.t} y2={H - PAD.b} className="stroke-muted" />
          <circle cx={hx} cy={hy} r="3" fill={color} className="stroke-panel" strokeWidth="1.5" />
          <text x={labelLeft ? hx - 8 : hx + 8} y={Math.max(PAD.t + 10, hy - 8)} textAnchor={labelLeft ? "end" : "start"} fontSize="10" className="fill-fg" fontFamily={mono}>
            {Math.round(h[1])}% used · {fmtTime(h[0])}
          </text>
        </g>
      )}
    </svg>
  );
}
