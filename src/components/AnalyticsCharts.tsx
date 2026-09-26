"use client";

import { useState } from "react";
import { formatTokens } from "@/lib/activity";
import { formatMoney } from "@/lib/format";
import { TOOL_NAME } from "@/lib/team";
import { formatHours, type ModelShare, type ProjectBar, type WeekHours } from "@/lib/team-analytics";
import { ProviderGlyph } from "./ProviderLogo";

/*
 * The Analytics tab's smaller charts. Each shows what the pointer is on in a
 * line of its own (no floating box to cover the marks), and carries its
 * numbers as a table for screen readers.
 */

/** Monday first, as the week reads at work. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
const hourName = (h: number) => new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
const hourSpan = (h: number) =>
  `${new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}–${new Date(2024, 0, 1, h + 1).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;

/** A heat cell's fill: the surface for nothing, then one hue (--heat) growing from it. */
const heat = (v: number, max: number) => (v <= 0 || max <= 0 ? "var(--track)" : `color-mix(in oklab, var(--heat) ${Math.round(18 + 82 * (v / max))}%, var(--panel))`);

/** When the work happens: weekdays by hours of the day, darker where more. */
export function WeekHeatmap({ data, people }: { data: WeekHours; people: number }) {
  const [at, setAt] = useState<[number, number] | null>(null);
  const value = (v: number) => (data.kind === "active" ? formatHours(v) : `${v} session${v === 1 ? "" : "s"} started`);
  let peak: [number, number] | null = null;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) if (data.cells[d][h] > 0 && (!peak || data.cells[d][h] > data.cells[peak[0]][peak[1]])) peak = [d, h];
  }
  const shown = at ?? peak;
  const empty = data.max === 0;
  return (
    <div className="px-4 py-3">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }} onPointerLeave={() => setAt(null)}>
        {data.cells.map((row, d) => (
          <div key={d} className="contents">
            <span className="self-center pr-1 text-right text-[10px] text-muted">{WEEKDAYS[d]}</span>
            {row.map((v, h) => (
              <span
                key={h}
                role="img"
                aria-label={`${WEEKDAYS[d]} ${hourSpan(h)}: ${value(v)}`}
                onPointerEnter={() => setAt([d, h])}
                className={`aspect-square min-h-2 rounded-[3px] transition-[outline] ${at?.[0] === d && at?.[1] === h ? "outline outline-2 outline-offset-1 outline-fg" : ""}`}
                style={{ background: heat(v, data.max) }}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="whitespace-nowrap text-[10px] text-muted">
            {h % 6 === 0 ? hourName(h) : ""}
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]">
        <span className="min-w-0 font-mono text-muted">
          {empty
            ? "Nothing in this period."
            : shown
              ? `${WEEKDAYS[shown[0]]} ${hourSpan(shown[1])} · ${value(data.cells[shown[0]][shown[1]])}${!at ? " · busiest" : ""}${people > 1 && data.kind === "active" ? ", people added up" : ""}`
              : ""}
        </span>
        <span className="flex items-center gap-1 text-muted" aria-hidden>
          less
          {[0.05, 0.3, 0.55, 0.8, 1].map((f) => (
            <span key={f} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: heat(f, 1) }} />
          ))}
          more
        </span>
      </div>
      <div className="sr-only">
        <table>
          <caption>{data.kind === "active" ? "Active time by weekday and hour" : "Sessions started by weekday and hour"}</caption>
          <thead>
            <tr>
              <th>Day</th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h}>{hourSpan(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.cells.map((row, d) => (
              <tr key={d}>
                <th>{WEEKDAYS[d]}</th>
                {row.map((v, h) => (
                  <td key={h}>{data.kind === "active" ? formatHours(v) : v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Projects as bars split by person, longest first, each with its total at the end. */
export function ProjectBars({ bars, format, onOpen }: { bars: ProjectBar[]; format: (v: number) => string; onOpen: (project: string) => void }) {
  const [on, setOn] = useState<{ project: string; key: string } | null>(null);
  const max = Math.max(0, ...bars.map((b) => b.total));
  const hovered = on && bars.find((b) => b.name === on.project)?.parts.find((p) => p.key === on.key);
  return (
    <div className="px-4 py-3">
      <ul className="space-y-2.5" onPointerLeave={() => setOn(null)}>
        {bars.map((b) => (
          <li key={b.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]">
            <button type="button" onClick={() => onOpen(b.name)} className="truncate text-left text-sm text-fg-2 hover:text-fg" title={`${b.name}: its sessions`}>
              {b.name}
            </button>
            <span className="flex h-2.5 min-w-0 gap-[2px]" style={{ width: `${Math.max(1, (b.total / max) * 100)}%` }}>
              {b.parts.map((p, i) => (
                <span
                  key={p.key}
                  role="img"
                  aria-label={`${p.label}: ${format(p.value)}`}
                  onPointerEnter={() => setOn({ project: b.name, key: p.key })}
                  className={`h-full min-w-[2px] ${i === b.parts.length - 1 ? "rounded-r" : ""} ${on && (on.project !== b.name || on.key !== p.key) ? "opacity-45" : ""}`}
                  style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
                />
              ))}
            </span>
            <span className="font-mono text-xs tabular-nums text-fg">{format(b.total)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 min-h-4 truncate font-mono text-[11px] text-muted">
        {hovered && on ? `${on.project} · ${hovered.label} · ${format(hovered.value)}` : bars.length ? "Point at a bar for whose work it is; a name opens its sessions." : ""}
      </p>
      <div className="sr-only">
        <table>
          <caption>Projects by person</caption>
          <tbody>
            {bars.map((b) => (
              <tr key={b.name}>
                <th>{b.name}</th>
                <td>{format(b.total)}</td>
                <td>{b.parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Models by the tokens they used, with their share and what that is worth. The bars are ink, not a colour: colours on this page are people. */
export function ModelBars({ models }: { models: ModelShare[] }) {
  const [all, setAll] = useState(false);
  const total = models.reduce((n, m) => n + m.tokens, 0);
  const max = Math.max(0, ...models.map((m) => m.tokens));
  const shown = all ? models : models.slice(0, 6);
  return (
    <div className="px-4 py-3">
      <ul className="space-y-2.5">
        {shown.map((m) => (
          <li key={m.model} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-2" title={`${m.model} · ${TOOL_NAME[m.tool]}`}>
              <ProviderGlyph provider={m.tool} size={12} />
              <span className="truncate">{m.model}</span>
            </span>
            <span className="h-2.5 min-w-[2px] rounded-r bg-fg/40" style={{ width: `${Math.max(1, (m.tokens / max) * 100)}%` }} aria-hidden />
            <span className="text-right font-mono text-[11px] tabular-nums text-muted">
              <span className="text-fg">{m.tokens / total < 0.01 ? "<1" : Math.round((m.tokens / total) * 100)}%</span> · {formatTokens(m.tokens)}
              {m.value !== null && m.value > 0 ? ` · ≈ ${formatMoney(m.value)}` : m.value === null ? " · unpriced" : ""}
            </span>
          </li>
        ))}
      </ul>
      {models.length > 6 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-[11px] text-muted hover:text-fg">
          {all ? "Fewer" : `All ${models.length} models`}
        </button>
      )}
      <div className="sr-only">
        <table>
          <caption>Tokens by model</caption>
          <tbody>
            {models.map((m) => (
              <tr key={m.model}>
                <th>{m.model}</th>
                <td>{formatTokens(m.tokens)} tokens</td>
                <td>{m.value === null ? "unpriced" : formatMoney(m.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A small column per day, for a table row. */
export function MiniColumns({ values, color, label }: { values: number[]; color: string; label: string }) {
  const max = Math.max(0, ...values);
  const w = 3;
  const gap = 1;
  const h = 18;
  return (
    <svg width={values.length * (w + gap) - gap} height={h} role="img" aria-label={label} className="shrink-0">
      {values.map((v, i) => {
        const bh = v > 0 && max > 0 ? Math.max(1.5, (v / max) * h) : 1;
        return <rect key={i} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1} fill={v > 0 ? color : "var(--track)"} />;
      })}
    </svg>
  );
}
