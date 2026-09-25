"use client";

import { formatTokens, lastDays } from "@/lib/activity";
import { formatAgo, formatCountdown, formatMoney } from "@/lib/format";
import { spendSummary } from "@/lib/spend";
import { manages, type Workspace } from "@/lib/team";
import { dailySeries, limitAlerts, liveNow, projectsOf, rollupProjects, totalsSince, type Period, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { Big, Note, Tile } from "./Overview";
import { ProviderGlyph } from "./ProviderLogo";
import { Avatar, Card, Empty } from "./TeamBits";
import { RunLine, SessionLine } from "./TeamSessions";
import { UsageChart } from "./UsageChart";

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  period: Period;
  now: number;
  onOpenRun: (id: string) => void;
  onOpenSession: (key: string) => void;
  onShowSessions: () => void;
  onShowComputers: () => void;
};

/** Live sessions shown here before "all sessions". */
const LIVE_SHOWN = 6;

/** The team at a glance: what runs now, people and computers, tokens and what they are worth, subscriptions, what needs attention. */
export function TeamOverview({ ws, sessions, period, now, onOpenRun, onOpenSession, onShowSessions, onShowComputers }: Props) {
  const days = lastDays(period, now);
  const visible = ws.members.filter((m) => m.detailed);
  const devices = visible.flatMap((m) => m.devices);
  const projects = projectsOf(devices);
  const totals = totalsSince(projects, days[0]);
  const accounts = visible.flatMap((m) => m.accounts);
  const spend = spendSummary(accounts, Object.fromEntries(accounts.map((a) => [a.id, a.usage ?? undefined])));
  const alerts = limitAlerts(visible);
  const busiest = rollupProjects(visible, days[0]).slice(0, 5);
  const live = liveNow(ws, sessions);
  const liveCount = live.sessions.length + live.runs.length;
  const liveShown = live.sessions.slice(0, Math.max(0, LIVE_SHOWN - live.runs.length));
  const online = devices.filter((d) => d.online).length;
  const yours = !ws.team || !manages(ws.role);

  return (
    <div className="space-y-6">
      {devices.length === 0 && (
        <div className="fade-in flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-panel px-4 py-3">
          <p className="text-sm text-fg-2">
            {yours ? "Connect your computer" : "No computers are connected yet"}: open the AI Cooldown desktop app, sign in, and press{" "}
            <span className="font-medium text-fg">Connect this computer</span> under This machine. Projects, token usage and remote sessions come from there.
          </p>
          <button type="button" onClick={onShowComputers} className="btn">
            <Icon name="monitor" />
            How it works
          </button>
        </div>
      )}

      <div className="fade-in grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={ws.team ? "people" : "computers"} title="Who is in the workspace, and which of their computers checked in within the last few minutes">
          <Big>{ws.team ? ws.members.length : devices.length}</Big>
          <Note>
            {online} of {devices.length} computer{devices.length === 1 ? "" : "s"} online{yours && ws.team ? " (yours)" : ""} · {liveCount} session
            {liveCount === 1 ? "" : "s"} live
          </Note>
        </Tile>
        <Tile label={`tokens · ${period} days`} title="Every token Claude Code and Codex read and wrote, cache included, from the connected computers' session logs">
          <Big>{formatTokens(totals.tokens)}</Big>
          <Note>
            {formatTokens(totals.output)} written · {totals.messages.toLocaleString()} replies{yours && ws.team ? " · yours" : ""}
          </Note>
        </Tile>
        <Tile label="api value" title="What these tokens would cost at Anthropic's and OpenAI's API list prices. Subscriptions do not bill per token.">
          <Big>≈ {formatMoney(totals.cost)}</Big>
          <Note>
            at API list prices
            {totals.unpriced.length ? ` · ${totals.unpriced.length} model${totals.unpriced.length === 1 ? "" : "s"} unpriced` : ""}
          </Note>
        </Tile>
        <Tile label="subscriptions" title="List prices of the plans the linked accounts report">
          <Big>{spend.monthly > 0 ? `${formatMoney(spend.monthly)}/mo` : "—"}</Big>
          <Note>
            {accounts.length} linked account{accounts.length === 1 ? "" : "s"}
            {spend.week && ` · ${Math.round((spend.week.used / spend.week.total) * 100)}% of this week used`}
          </Note>
        </Tile>
      </div>

      <Card title="Tokens per day">
        <div className="px-4 py-3">
          <UsageChart points={dailySeries(projects, days)} />
        </div>
      </Card>

      {liveCount > 0 && (
        <Card
          title={`Live now · ${liveCount}`}
          action={
            <button type="button" onClick={onShowSessions} className="text-[11px] text-muted hover:text-fg">
              all sessions →
            </button>
          }
        >
          <ul className="divide-y divide-line">
            {live.runs.map((r) => (
              <RunLine key={r.id} run={r} team={Boolean(ws.team)} now={now} onOpen={() => onOpenRun(r.id)} />
            ))}
            {liveShown.map((s) => (
              <SessionLine key={s.key} s={s} showMember={Boolean(ws.team)} now={now} onOpen={() => onOpenSession(s.key)} />
            ))}
          </ul>
          {live.sessions.length > liveShown.length && (
            <button type="button" onClick={onShowSessions} className="w-full border-t border-line px-4 py-2 text-center text-xs text-muted hover:bg-panel-2 hover:text-fg">
              {live.sessions.length - liveShown.length} more live
            </button>
          )}
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Limits running out">
          {alerts.length === 0 ? (
            <Empty>{accounts.length ? "Every linked account has room left." : "No linked accounts yet. They come from the dashboard's Add account."}</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {alerts.map(({ member, account, window }) => {
                const resetMs = window.resetsAt ? new Date(window.resetsAt).getTime() - now : null;
                return (
                  <li key={account.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ProviderGlyph provider={account.provider} size={16} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg">{account.label}</p>
                      <p className="truncate font-mono text-[11px] text-muted">
                        {ws.team ? `${member.email} · ` : ""}
                        {window.label}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`font-mono text-sm font-semibold ${window.usedPercent >= 100 ? "text-rose-600 dark:text-rose-300" : "text-amber-600 dark:text-amber-300"}`}>
                        {Math.round(window.usedPercent)}% used
                      </p>
                      <p className="font-mono text-[11px] text-muted">{resetMs === null ? "no reset time" : resetMs > 0 ? `resets in ${formatCountdown(resetMs)}` : "reset due"}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Busiest projects">
          {busiest.length === 0 ? (
            <Empty>No project activity in the last {period} days.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {busiest.map((p) => (
                <li key={p.name} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name="folder" size={15} className="shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{p.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {p.branches[0] ? `${p.branches[0]} · ` : ""}active {formatAgo(now - p.lastActive)}
                    </p>
                  </div>
                  {ws.team && (
                    <span className="flex -space-x-1.5">
                      {p.people.slice(0, 4).map((m) => (
                        <span key={m.id} title={m.email} className="rounded-full ring-2 ring-panel">
                          <Avatar email={m.email} size={20} />
                        </span>
                      ))}
                    </span>
                  )}
                  <div className="w-20 shrink-0 text-right">
                    <p className="font-mono text-sm text-fg">{formatTokens(p.totals.tokens)}</p>
                    <p className="font-mono text-[11px] text-muted">{p.totals.cost > 0 ? `≈ ${formatMoney(p.totals.cost)}` : "—"}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
