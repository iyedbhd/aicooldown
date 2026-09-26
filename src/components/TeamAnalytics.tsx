"use client";

import { useMemo, useState, type ReactNode } from "react";
import { dayKey, formatTokens, lastDays } from "@/lib/activity";
import { formatMoney } from "@/lib/format";
import { manages, WORK_VERSION, type Workspace } from "@/lib/team";
import {
  change,
  daySeries,
  describeMeasure,
  formatCount,
  formatHours,
  formatMeasure,
  HISTORY_DAYS,
  MEASURES,
  measureOf,
  measureTotal,
  modelShares,
  peopleStats,
  projectBars,
  sumTotals,
  totalsOver,
  weekHours,
  type Measure,
  type PersonStats,
  type Totals,
} from "@/lib/team-analytics";
import type { Period } from "@/lib/team-stats";
import { MiniColumns, ModelBars, ProjectBars, WeekHeatmap } from "./AnalyticsCharts";
import { ColumnChart } from "./ColumnChart";
import { Icon } from "./Icon";
import { Big, Note, Tile } from "./Overview";
import { Card, Empty, RoleBadge, SharingChip } from "./TeamBits";
import type { SessionFilter } from "./TeamSessions";

type Props = {
  ws: Workspace;
  period: Period;
  now: number;
  /** "all", or the one person the tab is about. */
  person: string;
  onPerson: (id: string) => void;
  onShowSessions: (only: Partial<SessionFilter>) => void;
  onShowComputers: () => void;
};

/** The measure last picked, per browser. */
const MEASURE_KEY = "aic:analytics-measure";

function storedMeasure(): Measure {
  try {
    const v = localStorage.getItem(MEASURE_KEY);
    return MEASURES.some((m) => m.id === v) ? (v as Measure) : "tokens";
  } catch {
    return "tokens";
  }
}

const control = "rounded-lg border border-line bg-panel-2 px-2 py-1 text-xs text-fg";

/** Days in a month, for what a plan costs over a period. */
const MONTH_DAYS = 365 / 12;

type Row = { p: PersonStats; t: Totals; before: Totals | null; values: number[] };

/** How a number compares with the period before: "▲ 12% vs the 7 days before"; null without a period before to compare with. */
function delta(now: number, before: number | null, period: number, absolute = false): string | null {
  if (before === null) return null;
  const since = `the ${period} days before`;
  if (now === before) return now > 0 ? `same as ${since}` : null;
  if (absolute) return `${now > before ? "▲ +" : "▼ −"}${Math.abs(now - before)} vs ${since}`;
  const c = change(now, before);
  if (c === null) return `new vs ${since}`;
  const pct = Math.round(c * 100);
  return pct === 0 ? `about the same as ${since}` : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${since}`;
}

/** Tile notes, with a dot between those there are. */
const notes = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(" · ");

/**
 * How the people in the workspace work with Claude Code and Codex, and what
 * comes of it: activity, prompts, changes, time, tokens and their worth, per
 * day and person, when, on what, with which models.
 */
export function TeamAnalytics({ ws, period, now, person, onPerson, onShowSessions, onShowComputers }: Props) {
  const [measure, setMeasureState] = useState<Measure>(storedMeasure);
  const today = dayKey(now);
  const stats = useMemo(() => peopleStats(ws), [ws]);

  function setMeasure(m: Measure) {
    setMeasureState(m);
    try {
      localStorage.setItem(MEASURE_KEY, m);
    } catch {
      /* remembering it is a nicety */
    }
  }

  const view = useMemo(() => {
    const noon = Date.parse(`${today}T12:00:00`);
    const days = lastDays(period, noon);
    const prev = period * 2 <= HISTORY_DAYS ? lastDays(period * 2, noon).slice(0, period) : null;
    const rows: Row[] = stats.map((p) => ({
      p,
      t: totalsOver(p.days, days),
      before: prev && totalsOver(p.days, prev),
      values: days.map((d) => measureOf(p.days.get(d), measure)),
    }));
    const chosen = rows.filter((r) => person === "all" || r.p.member.id === person);
    const selected = chosen.length ? chosen : rows;
    const people = selected.map((r) => r.p);
    return {
      days,
      prev,
      rows,
      selected,
      total: sumTotals(selected.map((r) => r.t)),
      before: prev && sumTotals(selected.map((r) => r.before!)),
      everyone: sumTotals(rows.map((r) => r.t)),
      series: daySeries(people, days, measure),
      heat: weekHours(people, days),
      projects: projectBars(people, days, measure, 8),
      models: modelShares(people, days),
      computers: people.reduce((n, p) => n + p.computers, 0),
      outdated: people.flatMap((p) => p.outdated.map((device) => ({ device, email: p.member.email }))),
      capped: people.some((p) => p.capped),
      plans: people.reduce((n, p) => n + p.plans, 0),
    };
  }, [stats, today, period, measure, person]);

  const M = MEASURES.find((m) => m.id === measure)!;
  const team = Boolean(ws.team);
  const single = view.selected.length === 1;
  const one = single ? view.selected[0].p : null;
  const reporting = view.computers - view.outdated.length;
  const noWork = view.computers > 0 && reporting === 0;
  const t = view.total;
  const b = view.before;
  const planCost = (view.plans * period) / MONTH_DAYS;
  const who = one ? (one.member.id === ws.me.id ? "you" : one.member.email) : "they";

  if (stats.every((p) => p.computers === 0)) {
    return (
      <Card title="Analytics">
        <div className="px-4 py-8 text-center">
          <Icon name="trend" size={26} className="mx-auto text-faint" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Analytics come from the Claude Code and Codex logs of connected computers: open the AI Cooldown desktop app, sign in, and press Connect this computer
            under This machine.
          </p>
          <button type="button" onClick={onShowComputers} className="btn mt-4">
            <Icon name="monitor" />
            How it works
          </button>
        </div>
      </Card>
    );
  }

  const workTile = (value: string, note: string | null) =>
    noWork ? (
      <>
        <Big>—</Big>
        <Note>needs AI Cooldown {WORK_VERSION} or later</Note>
      </>
    ) : (
      <>
        <Big>{value}</Big>
        <Note>{note}</Note>
      </>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {stats.length > 1 && (
          <select value={one && person !== "all" ? one.member.id : "all"} onChange={(e) => onPerson(e.target.value)} aria-label="Person" className={`${control} max-w-64`}>
            <option value="all">Everyone</option>
            {stats.map((p) => (
              <option key={p.member.id} value={p.member.id}>
                {p.member.email}
                {p.member.id === ws.me.id ? " (you)" : ""}
              </option>
            ))}
          </select>
        )}
        <div role="radiogroup" aria-label="Measure" className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel-2 p-0.5">
          {MEASURES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={measure === m.id}
              title={m.help}
              onClick={() => setMeasure(m.id)}
              className={`shrink-0 rounded-md px-2 py-0.5 text-xs transition ${measure === m.id ? "bg-panel-3 text-fg" : "text-muted hover:text-fg-2"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {team && !manages(ws.role) && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Icon name="lock" size={12} className="mt-0.5 shrink-0" />
          These are yours: only the team&apos;s owner and admins see everyone&apos;s.
        </p>
      )}
      {view.outdated.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          <span>
            Prompts, lines changed and active time come from computers running AI Cooldown {WORK_VERSION} or later.{" "}
            {noWork ? "Update it on " : "Not reported yet by "}
            {view.outdated.map((o, i) => (
              <span key={`${o.email}:${o.device}`}>
                {i > 0 ? (i === view.outdated.length - 1 ? " and " : ", ") : ""}
                <span className="text-fg-2">{o.device}</span>
                {team && !single ? ` (${o.email})` : ""}
              </span>
            ))}
            {noWork ? "." : ": those numbers leave them out."}
          </span>
        </p>
      )}

      <div className="fade-in grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {single ? (
          <Tile label="active days" title="Days with any Claude Code or Codex activity">
            <Big>
              {t.activeDays} <span className="text-base font-normal text-muted">of {period}</span>
            </Big>
            <Note>{delta(t.activeDays, b && b.activeDays, period, true)}</Note>
          </Tile>
        ) : (
          <Tile label="people active" title="People with any Claude Code or Codex activity in the period">
            <Big>
              {view.selected.filter((r) => r.t.activeDays > 0).length} <span className="text-base font-normal text-muted">of {view.selected.length}</span>
            </Big>
            <Note>
              {delta(
                view.selected.filter((r) => r.t.activeDays > 0).length,
                view.prev && view.selected.filter((r) => r.before!.activeDays > 0).length,
                period,
                true,
              )}
            </Note>
          </Tile>
        )}
        <Tile label="sessions" title="Claude Code and Codex sessions started in the period">
          <Big>{formatCount(t.sessions)}</Big>
          <Note>{view.capped ? "the latest 300 per computer" : delta(t.sessions, b && b.sessions, period)}</Note>
        </Tile>
        <Tile label="prompts" title={MEASURES.find((m) => m.id === "prompts")!.help}>
          {workTile(formatCount(t.prompts), delta(t.prompts, b && b.prompts, period))}
        </Tile>
        <Tile label="lines changed" title={`${MEASURES.find((m) => m.id === "lines")!.help}: ${formatCount(t.edits)} file changes, ${formatCount(t.commands)} commands run`}>
          {workTile(formatCount(t.added + t.removed), notes(`+${formatCount(t.added)} −${formatCount(t.removed)}`, delta(t.added + t.removed, b && b.added + b.removed, period)))}
        </Tile>
        <Tile label="active time" title={MEASURES.find((m) => m.id === "active")!.help}>
          {workTile(formatHours(t.hours), delta(t.hours, b && b.hours, period))}
        </Tile>
        <Tile label="api value" title="What the tokens would cost at Anthropic's and OpenAI's API list prices, next to what the linked accounts' plans cost for the period">
          <Big>≈ {formatMoney(t.value)}</Big>
          <Note>
            {notes(
              `${formatTokens(t.tokens)} tokens`,
              planCost > 0 && t.value > 0 && `${ratio(t.value, planCost)}× the plans' ${formatMoney(planCost)}`,
              t.unpriced.length > 0 && `${t.unpriced.length} model${t.unpriced.length === 1 ? "" : "s"} unpriced`,
            )}
          </Note>
        </Tile>
      </div>

      <Card title={`${M.label} per day${one ? ` · ${one.member.id === ws.me.id ? "you" : one.member.email}` : ""}`} action={<span className="font-mono text-[11px] text-faint">{describeMeasure(measure, measureTotal(t, measure))}</span>}>
        <div className="px-4 py-3">
          <ColumnChart
            days={view.days}
            series={view.series}
            format={(v) => formatMeasure(measure, v)}
            describe={(v) => describeMeasure(measure, v)}
            note={(i) => {
              const ofDay = view.selected.map((r) => r.p.days.get(view.days[i]));
              if (measure === "tokens") {
                const value = ofDay.reduce((n, d) => n + (d?.value ?? 0), 0);
                return value > 0 ? `≈ ${formatMoney(value)} at API prices` : null;
              }
              if (measure === "lines") return `+${formatCount(ofDay.reduce((n, d) => n + (d?.added ?? 0), 0))} −${formatCount(ofDay.reduce((n, d) => n + (d?.removed ?? 0), 0))}`;
              return null;
            }}
            label={`${M.label} per day`}
            empty={M.work && noWork ? `Computers report ${M.noun} from AI Cooldown ${WORK_VERSION} on.` : `Nothing in the last ${period} days.`}
          />
        </div>
      </Card>

      {!single && <PeopleTable rows={view.selected} measure={measure} total={measureTotal(t, measure)} me={ws.me.id} onPerson={onPerson} />}

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Card
          title={view.heat.kind === "active" ? `When ${who} work${one && who !== "you" ? "s" : ""}` : "When sessions start"}
          action={<span className="font-mono text-[11px] text-faint">{view.heat.kind === "active" ? "each computer's time" : "your time"}</span>}
        >
          <WeekHeatmap data={view.heat} people={view.selected.length} />
        </Card>
        <Card title={`Projects · ${M.noun}`}>
          {view.projects.length === 0 ? (
            <Empty>{M.work && noWork ? `Needs AI Cooldown ${WORK_VERSION} or later on the computers.` : `No project activity in the last ${period} days.`}</Empty>
          ) : (
            <ProjectBars bars={view.projects} format={(v) => formatMeasure(measure, v)} onOpen={(project) => onShowSessions({ project, ...(one && person !== "all" ? { person: one.member.id } : {}) })} />
          )}
        </Card>
        <Card title="Models · tokens">{view.models.length === 0 ? <Empty>No tokens in the last {period} days.</Empty> : <ModelBars models={view.models} />}</Card>
        <Card title="Efficiency">
          <Efficiency
            rows={[
              ...view.selected.map((r) => ({ key: r.p.member.id, label: r.p.member.id === ws.me.id ? `${r.p.member.email} (you)` : r.p.member.email, color: r.p.color, t: r.t, plans: r.p.plans })),
              ...(view.rows.length > 1 ? [{ key: "everyone", label: "Everyone", color: null, t: view.everyone, plans: stats.reduce((n, p) => n + p.plans, 0) }] : []),
            ]}
            period={period}
          />
        </Card>
      </div>
    </div>
  );
}

type SortKey = "person" | "days" | "sessions" | "prompts" | "lines" | "active" | "tokens" | "value";

const COLUMNS: { key: Exclude<SortKey, "person">; label: string; title: string; work?: boolean; get: (t: Totals) => number; show: (t: Totals) => string }[] = [
  { key: "days", label: "Days", title: "Days with any activity", get: (t) => t.activeDays, show: (t) => String(t.activeDays) },
  { key: "sessions", label: "Sessions", title: "Sessions started", get: (t) => t.sessions, show: (t) => formatCount(t.sessions) },
  { key: "prompts", label: "Prompts", title: "Prompts typed", work: true, get: (t) => t.prompts, show: (t) => formatCount(t.prompts) },
  { key: "lines", label: "Lines", title: "Lines added and removed", work: true, get: (t) => t.added + t.removed, show: (t) => `+${formatCount(t.added)} −${formatCount(t.removed)}` },
  { key: "active", label: "Active", title: "Active time", work: true, get: (t) => t.hours, show: (t) => formatHours(t.hours) },
  { key: "tokens", label: "Tokens", title: "Tokens read and written", get: (t) => t.tokens, show: (t) => formatTokens(t.tokens) },
  { key: "value", label: "API value", title: "What the tokens would cost at API list prices", get: (t) => t.value, show: (t) => `≈ ${formatMoney(t.value)}` },
];

const MEASURE_COLUMN: Record<Measure, Exclude<SortKey, "person">> = { tokens: "tokens", value: "value", sessions: "sessions", prompts: "prompts", lines: "lines", active: "active" };

/** Everyone side by side: a row each, sortable by any column, with their days of the chosen measure and their share of it. A name shows only theirs. */
function PeopleTable({ rows, measure, total, me, onPerson }: { rows: Row[]; measure: Measure; total: number; me: string; onPerson: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const by = sort ?? { key: MEASURE_COLUMN[measure], desc: true };
  const column = COLUMNS.find((c) => c.key === by.key);
  const sorted = [...rows].sort((x, y) => {
    const d = column ? column.get(x.t) - column.get(y.t) : x.p.member.email.localeCompare(y.p.member.email);
    return by.desc ? -d : d;
  });
  const M = MEASURES.find((m) => m.id === measure)!;
  const header = (key: SortKey, label: string, title: string, align = "text-right") => (
    <th key={key} scope="col" aria-sort={by.key === key ? (by.desc ? "descending" : "ascending") : "none"} className={`px-3 py-2 font-normal ${align}`}>
      <button type="button" title={title} onClick={() => setSort({ key, desc: by.key === key ? !by.desc : key !== "person" })} className="eyebrow inline-flex items-center gap-1 hover:text-fg">
        {label}
        {by.key === key && <Icon name="chevron" size={10} className={by.desc ? "" : "rotate-180"} />}
      </button>
    </th>
  );
  return (
    <Card title={`People · ${rows.length}`} action={<span className="font-mono text-[11px] text-faint">a name shows only theirs</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b border-line">
            <tr>
              {header("person", "Person", "Sort by email", "text-left")}
              {COLUMNS.map((c) => header(c.key, c.label, c.title))}
              <th scope="col" className="px-3 py-2 text-left font-normal">
                <span className="eyebrow">{M.label} per day</span>
              </th>
              <th scope="col" className="px-3 py-2 text-left font-normal">
                <span className="eyebrow">share</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sorted.map((r) => {
              const outdated = r.p.computers > 0 && r.p.outdated.length === r.p.computers;
              const share = total > 0 ? measureTotal(r.t, measure) / total : 0;
              return (
                <tr key={r.p.member.id} className="hover:bg-panel-2">
                  <td className="max-w-[16rem] px-3 py-2">
                    <button type="button" onClick={() => onPerson(r.p.member.id)} className="flex min-w-0 items-center gap-2 text-left" title={`Only ${r.p.member.email}`}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.p.color }} aria-hidden />
                      <span className="truncate text-fg hover:underline">{r.p.member.email}</span>
                      {r.p.member.id === me && <span className="shrink-0 text-[11px] text-faint">you</span>}
                      {r.p.member.role && r.p.member.role !== "member" && <RoleBadge role={r.p.member.role} />}
                    </button>
                    {r.p.member.sharing === "picked" && r.p.member.id !== me && (
                      <span className="mt-1 block">
                        <SharingChip sharing="picked" />
                      </span>
                    )}
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular-nums text-fg-2" title={c.work && outdated ? `Needs AI Cooldown ${WORK_VERSION} or later on their computers` : undefined}>
                      {c.work && outdated ? "—" : c.show(r.t)}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <MiniColumns values={r.values} color={r.p.color} label={`${M.label} per day: ${r.values.map((v) => formatMeasure(measure, v)).join(", ")}`} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-track" aria-hidden>
                        <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: r.p.color }} />
                      </span>
                      <span className="w-9 font-mono text-[11px] tabular-nums text-muted">{Math.round(share * 100)}%</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type EfficiencyRow = { key: string; label: string; color: string | null; t: Totals; plans: number };

/** A ratio with the digits it needs: "12", "4.2", "0.35"; "—" without a base. */
function ratio(a: number, b: number): string {
  if (b <= 0) return "—";
  const r = a / b;
  return r >= 10 ? String(Math.round(r)) : r >= 1 ? r.toFixed(1) : r > 0 ? r.toFixed(2) : "0";
}

/**
 * Ratios that say how someone works: prompts per session, lines per prompt,
 * how much of what the models read came from the cache, and value for the
 * plans' money. Prompts per session counts only sessions on computers that
 * report prompts.
 */
function Efficiency({ rows, period }: { rows: EfficiencyRow[]; period: number }) {
  const columns: { label: ReactNode; title: string; value: (t: Totals, plans: number) => string }[] = [
    { label: <>prompts/<wbr />session</>, title: "Prompts per session started, on the computers that report prompts", value: (t) => ratio(t.prompts, t.workSessions) },
    { label: <>lines/<wbr />prompt</>, title: "Lines added and removed per prompt", value: (t) => ratio(t.added + t.removed, t.prompts) },
    { label: <>cache <wbr />reads</>, title: "Share of what the models read that came from the cache: more is cheaper and faster", value: (t) => (t.read > 0 ? `${Math.round((t.cacheRead / t.read) * 100)}%` : "—") },
    { label: <>value/<wbr />plans</>, title: "API value over what the linked accounts' plans cost for the period", value: (t, plans) => (plans > 0 ? `${ratio(t.value, plans)}×` : "—") },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line">
          <tr>
            <th scope="col" className="py-2 pl-4 pr-2 text-left font-normal">
              <span className="eyebrow">person</span>
            </th>
            {columns.map((c, i) => (
              <th key={i} scope="col" title={c.title} className={`py-2 pl-2 text-right align-bottom font-normal ${i === columns.length - 1 ? "pr-4" : "pr-2"}`}>
                <span className="eyebrow">{c.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const plans = r.plans * (period / MONTH_DAYS);
            return (
              <tr key={r.key}>
                <td className="max-w-[10rem] py-2 pl-4 pr-2">
                  <span className="flex min-w-0 items-center gap-2" title={r.label}>
                    {r.color && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} aria-hidden />}
                    <span className={`truncate ${r.color ? "text-fg" : "text-muted"}`}>{r.label}</span>
                  </span>
                </td>
                {columns.map((c, i) => (
                  <td key={i} className={`py-2 pl-2 text-right font-mono text-xs tabular-nums text-fg-2 ${i === columns.length - 1 ? "pr-4" : "pr-2"}`}>
                    {c.value(r.t, plans)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
        Value/plans compares the tokens&apos; API value with what the linked accounts&apos; plans cost for these {period} days.
      </p>
    </div>
  );
}
