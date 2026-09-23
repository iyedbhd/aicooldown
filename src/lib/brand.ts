/**
 * The AI Cooldown mark as SVG markup: the one source for the logo the app
 * draws (components/Logo.tsx) and for every logo file scripts/brand.mjs writes.
 * That script imports this file with Node's type stripping, so it has no
 * imports and no TypeScript-only runtime syntax.
 *
 * A ring, almost full, that runs hot to cold along the arc: amber at a
 * white-hot head, then coral, pink, violet and blue, to ice cyan at the tail,
 * a cooldown running out. Inside it, the AI sparkle. SVG has no conic
 * gradient, so the ring is five 60° segments, each with a linear gradient from
 * its start point to its end point; round caps overlap at the joins so no seam
 * shows. Animated, it plays a cooldown: the ring fills head to tail over a
 * faint track while the sparkle waits, dimmed; when the ring closes, the
 * sparkle flares and the head pings "ready", then the ring fades and starts over.
 */

export const BRAND = {
  ink: "#080a1c", // tile, bottom-right
  inkTop: "#1d2150", // tile, top-left
  halo: "#8b7bff", // glow behind the sparkle
  tip: "#fff6ea", // head dot, white-hot
  ice: "#d4f3ff", // sparkle, fading down from white
  /** Colour at each 60° node around the ring, head to tail. */
  ring: ["#ffb13b", "#ff6a55", "#f4528f", "#b25cff", "#5a86ff", "#3fe0f5"],
} as const;

export type MarkOptions = {
  /** Prefix for the gradient and mask ids, unique within the page. */
  id: string;
  /** For 32px and below: a bolder ring and sparkle, and no glows. */
  small?: boolean;
  /** Square to the edges, for platforms that round the icon themselves. */
  bleed?: boolean;
  /** Play the cooldown, with the classes in globals.css or with SMIL inside a standalone file. */
  animate?: "css" | "smil";
};

const n = (v: number) => +v.toFixed(3);

/** Point on a circle around the tile's centre, `deg` clockwise from 12 o'clock. */
function pt(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [n(32 + r * Math.sin(a)), n(32 - r * Math.cos(a))];
}

/** A four-point star around the origin. `plump` 0 pinches its sides to the centre; 0.5 makes it a diamond. */
function sparkle(height: number, width: number, plump: number) {
  const [x, y] = [n(width * plump), n(height * plump)];
  return `M 0 ${-height} Q ${x} ${-y} ${width} 0 Q ${x} ${y} 0 ${height} Q ${-x} ${y} ${-width} 0 Q ${-x} ${-y} 0 ${-height} Z`;
}

const glow = (id: string, color: string, opacity: number) =>
  `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;

/** SMIL for one attribute over the 6s loop, keyed like the matching keyframes in globals.css. */
const loop = (attribute: string, values: string, keyTimes: string, tag = "animate", extra = "") =>
  `<${tag} attributeName="${attribute}"${extra} values="${values}" keyTimes="${keyTimes}" dur="6s" repeatCount="indefinite"/>`;

/** The mark's SVG content, for an `<svg viewBox="0 0 64 64">`. */
export function markBody({ id, small = false, bleed = false, animate }: MarkOptions): string {
  const r = small ? 19 : 19.5;
  const stroke = small ? 8.5 : 7;
  const [hx, hy] = pt(30, r);
  const [tx, ty] = pt(330, r);
  const arc = `M ${hx} ${hy} A ${r} ${r} 0 1 1 ${tx} ${ty}`;
  const css = (name: string) => (animate === "css" ? ` class="${name}"` : "");
  const smil = (...parts: string[]) => (animate === "smil" ? parts.join("") : "");

  const defs = [
    `<linearGradient id="${id}-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.inkTop}"/><stop offset="1" stop-color="${BRAND.ink}"/></linearGradient>`,
    `<linearGradient id="${id}-spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${BRAND.ice}"/></linearGradient>`,
  ];
  const art = [`<rect width="64" height="64"${bleed ? "" : ` rx="14"`} fill="url(#${id}-tile)"/>`];
  if (!small) {
    if (!bleed) art.push(`<rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#fff" stroke-opacity="0.08"/>`);
    defs.push(glow(`${id}-halo`, BRAND.halo, 0.22), glow(`${id}-glow`, BRAND.ring[0], 0.75));
    art.push(`<circle cx="32" cy="32" r="16" fill="url(#${id}-halo)"/>`);
  }
  if (animate) {
    defs.push(
      `<mask id="${id}-fill"><path d="${arc}" pathLength="100" fill="none" stroke="#fff" stroke-width="${stroke + 1}" stroke-linecap="round" stroke-dasharray="100"${css("cooldown-fill")}>` +
        smil(loop("stroke-dashoffset", "100;0;0;0;100", "0;0.66;0.86;0.93;1"), loop("opacity", "1;1;1;0;0", "0;0.66;0.86;0.93;1")) +
        `</path></mask>`,
    );
    art.push(`<path d="${arc}" fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="${stroke}" stroke-linecap="round"/>`);
  }

  const segments = BRAND.ring.slice(1).map((to, i) => {
    const [x1, y1] = pt(30 + i * 60, r);
    const [x2, y2] = pt(90 + i * 60, r);
    defs.push(
      `<linearGradient id="${id}-s${i}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${BRAND.ring[i]}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
    );
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="url(#${id}-s${i})" stroke-width="${stroke}" stroke-linecap="round"/>`;
  });
  art.push(animate ? `<g mask="url(#${id}-fill)">${segments.join("")}</g>` : segments.join(""));

  if (!small) art.push(`<circle cx="${hx}" cy="${hy}" r="${n(stroke * 1.25)}" fill="url(#${id}-glow)"/>`);
  if (animate) {
    art.push(
      `<circle cx="${hx}" cy="${hy}" r="3" fill="${BRAND.tip}"${animate === "smil" ? ` opacity="0"` : css("cooldown-ping")}>` +
        smil(loop("r", "3;3;3;10.8;10.8", "0;0.64;0.68;0.86;1"), loop("opacity", "0;0;0.85;0;0", "0;0.64;0.68;0.86;1")) +
        `</circle>`,
    );
  }
  art.push(`<circle cx="${hx}" cy="${hy}" r="${small ? 3 : 2.8}" fill="${BRAND.tip}"/>`);

  const star = small ? sparkle(11, 10, 0.22) : sparkle(11.5, 9.5, 0.14);
  const flare = "0;0.62;0.67;0.73;0.86;0.93;1";
  art.push(
    `<g transform="translate(32 32)"><path d="${star}" fill="url(#${id}-spark)"${css("cooldown-spark")}>` +
      smil(loop("transform", "0.8;0.8;1.18;1;1;0.8;0.8", flare, "animateTransform", ` type="scale"`), loop("opacity", "0.3;0.3;1;1;1;0.3;0.3", flare)) +
      `</path></g>`,
  );
  return `<defs>${defs.join("")}</defs>${art.join("")}`;
}
