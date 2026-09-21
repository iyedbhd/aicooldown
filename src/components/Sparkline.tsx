import { useId } from "react";
import type { Sample } from "@/lib/history";

type Props = { samples: Sample[]; color: string; width?: number; height?: number };

/** Tiny usage-over-time area from local polling history. Draws itself in on mount. */
export function Sparkline({ samples, color, width = 96, height = 24 }: Props) {
  const id = useId();
  if (samples.length < 2) {
    return (
      <svg width={width} height={height} className="shrink-0 opacity-30" aria-hidden>
        <title>History builds up while the dashboard polls</title>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke={color} strokeWidth="1" strokeDasharray="2 4" />
      </svg>
    );
  }
  const t0 = samples[0][0];
  const span = Math.max(samples[samples.length - 1][0] - t0, 1);
  const pad = 2;
  const pts = samples.map(([t, p]) => {
    const x = ((t - t0) / span) * (width - pad * 2) + pad;
    const y = height - pad - (Math.max(0, Math.min(100, p)) / 100) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")}`;
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  const [lastX, lastY] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" role="img" aria-label="Usage over the last 48 hours">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="draw-in" />
      <circle cx={lastX} cy={lastY} r="2.5" fill={color} className="live-dot" />
    </svg>
  );
}
