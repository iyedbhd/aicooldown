import { useId } from "react";

/*
 * The AI Cooldown mark: one 300° ring with a 60° gap at 12 o'clock and a
 * white-hot head dot. The colour travels along the arc, not across the tile:
 * red at the head, orange, amber, yellow, then lime, cooling to green at the
 * tail, like a meter clearing. SVG has no conic gradient, so the ring is five 60°
 * segments, each with a linear gradient from its start point to its end
 * point; round caps overlap at the joins so no seam shows. `animated` plays
 * a cooldown: the ring fills from the head around to the tail over a faint
 * track, the leading edge cooling as it goes, and when it completes the head
 * dot pings "ready" before the ring fades and starts over.
 */

export const BRAND = {
  ink: "#080c1a", // tile, bottom-right
  inkTop: "#141c38", // tile, top-left
  tip: "#fff3e0", // head dot (white-hot)
  /** Colour at each 60° node around the ring, head to tail. */
  ring: ["#ff4b4b", "#ff7a2e", "#ffab3a", "#ffd23f", "#9be15d", "#34d399"],
} as const;

/** Point on the ring at `deg` clockwise from 12 o'clock. */
function pt(deg: number, r: number, c = 32): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [+(c + r * Math.sin(a)).toFixed(3), +(c - r * Math.cos(a)).toFixed(3)];
}

/** Five 60° arc segments from 30° to 330°, with their endpoints. */
export function ringSegments(r: number) {
  return BRAND.ring.slice(0, -1).map((from, i) => {
    const [x1, y1] = pt(30 + i * 60, r);
    const [x2, y2] = pt(90 + i * 60, r);
    return { d: `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`, x1, y1, x2, y2, from, to: BRAND.ring[i + 1] };
  });
}

type MarkProps = { size?: number; animated?: boolean; className?: string; title?: string };

/** The whole 300° arc as one path, head to tail; its length is just under 100. */
const FULL_ARC = "M 41.5 15.545 A 19 19 0 1 1 22.5 15.545";

export function Mark({ size = 32, animated = false, className, title = "AI Cooldown" }: MarkProps) {
  const id = useId();
  const tile = `${id}-tile`;
  const glow = `${id}-glow`;
  const mask = `${id}-mask`;
  const segs = ringSegments(19);
  const [hx, hy] = pt(30, 19);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={BRAND.inkTop} />
          <stop offset="1" stopColor={BRAND.ink} />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0" stopColor={BRAND.ring[0]} stopOpacity="0.6" />
          <stop offset="1" stopColor={BRAND.ring[0]} stopOpacity="0" />
        </radialGradient>
        {segs.map((s, i) => (
          <linearGradient key={i} id={`${id}-s${i}`} gradientUnits="userSpaceOnUse" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}>
            <stop offset="0" stopColor={s.from} />
            <stop offset="1" stopColor={s.to} />
          </linearGradient>
        ))}
        {animated && (
          <mask id={mask}>
            <path
              d={FULL_ARC}
              fill="none"
              stroke="#fff"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray="100"
              className="cooldown-fill"
            />
          </mask>
        )}
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${tile})`} />
      {animated && <path d={FULL_ARC} fill="none" stroke="#fff" strokeOpacity="0.09" strokeWidth="6" strokeLinecap="round" />}
      <g mask={animated ? `url(#${mask})` : undefined}>
        {segs.map((s, i) => (
          <path key={i} d={s.d} fill="none" stroke={`url(#${id}-s${i})`} strokeWidth="6" strokeLinecap="round" />
        ))}
      </g>
      <circle cx={hx} cy={hy} r="8" fill={`url(#${glow})`} />
      {animated && <circle cx={hx} cy={hy} r="3" fill={BRAND.tip} className="cooldown-ping" />}
      <circle cx={hx} cy={hy} r="3" fill={BRAND.tip} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-semibold tracking-[-0.03em] text-fg ${className ?? ""}`}>AI Cooldown</span>;
}
