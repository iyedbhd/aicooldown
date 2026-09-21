"use client";

import { useRef, useState } from "react";
import type { Sample } from "@/lib/history";

const W = 600;
const H = 210;
const PAD = { l: 30, r: 10, t: 12, b: 22 };
const MIN_SPAN_MS = 60 * 60_000;

type Props = { samples: Sample[]; color: string; now: number };

/** Usage over the last 48 hours with a hover readout. Click a window row to open it. */
export function HistoryChart({ samples, color, now }: Props) {
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
  const span = now - t0;
  const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - PAD.t - PAD.b);
  const points = samples.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${x(samples[samples.length - 1][0]).toFixed(1)},${y(0)} L${x(samples[0][0]).toFixed(1)},${y(0)} Z`;
  const resets = samples.filter(([, p], i) => i > 0 && samples[i - 1][1] - p >= 30);
  const fmtTime = (t: number) =>
    new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

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

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 w-full cursor-crosshair select-none"
      role="img"
      aria-label="Usage history"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {[0, 50, 100].map((p) => (
        <g key={p}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} className="stroke-line" />
          <text x={PAD.l - 6} y={y(p) + 3} textAnchor="end" fontSize="9" className="fill-muted" fontFamily="var(--font-mono), monospace">
            {p}
          </text>
        </g>
      ))}
      {[t0, t0 + span / 2].map((t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor={t === t0 ? "start" : "middle"} fontSize="9" className="fill-muted" fontFamily="var(--font-mono), monospace">
          {fmtTime(t)}
        </text>
      ))}
      <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="9" className="fill-muted" fontFamily="var(--font-mono), monospace">
        now
      </text>
      {resets.map(([t]) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} stroke="#34d399" strokeOpacity=".6" strokeDasharray="2 3" />
          <text x={x(t) + 3} y={PAD.t + 9} fontSize="9" fill="#34d399" fontFamily="var(--font-mono), monospace">
            reset
          </text>
        </g>
      ))}
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      {h && (
        <g>
          <line x1={hx} x2={hx} y1={PAD.t} y2={H - PAD.b} className="stroke-muted" />
          <circle cx={hx} cy={hy} r="3" fill={color} className="stroke-panel" strokeWidth="1.5" />
          <text
            x={labelLeft ? hx - 8 : hx + 8}
            y={Math.max(PAD.t + 10, hy - 8)}
            textAnchor={labelLeft ? "end" : "start"}
            fontSize="10"
            className="fill-fg"
            fontFamily="var(--font-mono), monospace"
          >
            {Math.round(h[1])}% used · {fmtTime(h[0])}
          </text>
        </g>
      )}
    </svg>
  );
}
