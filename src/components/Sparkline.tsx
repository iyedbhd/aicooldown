import type { Sample } from "@/lib/history";

type Props = { samples: Sample[]; color: string; width?: number; height?: number };

/** Tiny usage-over-time line from local polling history. */
export function Sparkline({ samples, color, width = 96, height = 24 }: Props) {
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
  const pad = 1.5;
  const points = samples.map(([t, p]) => {
    const x = ((t - t0) / span) * (width - pad * 2) + pad;
    const y = height - pad - (Math.max(0, Math.min(100, p)) / 100) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lastX, lastY] = points[points.length - 1].split(",");
  return (
    <svg width={width} height={height} className="shrink-0" role="img" aria-label="Usage over the last 48 hours">
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="stroke-line" strokeWidth="1" />
      <path d={`M${points.join(" L")}`} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}
