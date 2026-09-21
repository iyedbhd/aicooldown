import { formatCountdown, formatDateTime } from "@/lib/format";
import type { ResetEvent } from "@/lib/stats";
import { PROVIDER_META, ProviderGlyph } from "./ProviderLogo";

const MIN_MS = 60_000;
const MAX_MS = 7 * 86400_000;
const TICKS: { label: string; ms: number }[] = [
  { label: "1m", ms: 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 3600_000 },
  { label: "6h", ms: 6 * 3600_000 },
  { label: "1d", ms: 86400_000 },
  { label: "3d", ms: 3 * 86400_000 },
  { label: "7d", ms: MAX_MS },
];

/** Position on a log-time axis from 1 minute (left) to 7 days (right). */
function x(ms: number): number {
  const clamped = Math.max(MIN_MS, Math.min(MAX_MS, ms));
  return Math.log(clamped / MIN_MS) / Math.log(MAX_MS / MIN_MS);
}

type Props = { events: ResetEvent[]; now: number };

/** Every upcoming reset on one log-scale strip, so minutes and days both fit. */
export function ResetTimeline({ events, now }: Props) {
  const width = 800;
  const height = 44;
  const top = 10;
  const margin = 14;
  const px = (ms: number) => margin + x(ms) * (width - margin * 2);
  const next = events.slice(0, 4);

  return (
    <div className="fade-in rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">Every upcoming reset, nearest first</span>
        <span className="font-mono text-[10px] text-faint">log scale · 1 minute → 7 days</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full" role="img" aria-label="Upcoming resets on a timeline">
        <line x1={margin} y1={top + 10} x2={width - margin} y2={top + 10} className="stroke-line" />
        {TICKS.map((t) => (
          <g key={t.label} transform={`translate(${px(t.ms)},0)`}>
            <line x1="0" y1={top + 6} x2="0" y2={top + 14} className="stroke-muted" />
            <text y={height - 4} textAnchor="middle" fontSize="9" className="fill-muted" fontFamily="var(--font-mono), monospace">
              {t.label}
            </text>
          </g>
        ))}
        {events.map((e) => {
          const accent = PROVIDER_META[e.account.provider].accent;
          return (
            <g key={`${e.account.id}-${e.window.key}`} transform={`translate(${px(e.at - now)},${top + 10})`} style={{ transition: "transform 1s linear" }}>
              <title>{`${e.account.label} · ${e.window.label} · in ${formatCountdown(e.at - now)} (${formatDateTime(e.window.resetsAt!, now)})`}</title>
              <line x1="0" y1="-8" x2="0" y2="0" stroke={accent} strokeWidth="1" />
              <circle cy={-9} r="3" className="fill-panel" stroke={accent} strokeWidth="1.5" />
            </g>
          );
        })}
      </svg>
      {next.length > 0 ? (
        <ul className="mt-2 grid gap-x-6 gap-y-1 font-mono text-[11px] tabular-nums sm:grid-cols-2">
          {next.map((e) => (
            <li key={`${e.account.id}-${e.window.key}`} className="flex items-baseline justify-between gap-3 text-muted">
              <span className="flex min-w-0 items-center gap-2 truncate">
                <ProviderGlyph provider={e.account.provider} size={11} className="shrink-0 opacity-90" />
                <span className="truncate">
                  {e.account.label} · {e.window.label}
                </span>
              </span>
              <span className="shrink-0 text-fg-2">{formatCountdown(e.at - now)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 font-mono text-[11px] text-faint">No reset times reported yet.</p>
      )}
    </div>
  );
}
