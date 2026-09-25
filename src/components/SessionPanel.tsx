"use client";

import { useEffect, useState } from "react";
import { formatTokens, rowTokens } from "@/lib/activity";
import { formatAgo, formatCountdown, formatMoney } from "@/lib/format";
import { costOf } from "@/lib/pricing";
import { fetchTranscript, requestTranscript, TOOL_NAME, type Transcript } from "@/lib/team";
import { sourceLabel, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { EventLine } from "./RunPanel";

const POLL_MS = 2_000;

type Props = { session: SessionRow; now: number; onClose: () => void; onOpenRun: (id: string) => void };

/**
 * One Claude Code or Codex session: where and when it ran, what it used, and
 * its conversation, which its computer reads from the CLI's log and sends when
 * asked, if it shares session content.
 */
export function SessionPanel({ session: s, now, onClose, onOpenRun }: Props) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  /** Bumped after each request, to follow it until the computer answers. */
  const [asked, setAsked] = useState(0);
  const shared = s.device.share;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!shared) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      void fetchTranscript(s.device.id, s.tool, s.id).then((res) => {
        if (!alive) return;
        if (!res.ok) return setError(res.error);
        setTranscript(res.data);
        if (res.data?.status === "pending") timer = setTimeout(poll, POLL_MS);
      });
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [shared, s.device.id, s.tool, s.id, asked]);

  async function ask(refresh: boolean) {
    setAsking(true);
    setError(null);
    const res = await requestTranscript(s.device.id, s.tool, s.id, refresh);
    setAsking(false);
    if (!res.ok) return setError(res.error);
    setTranscript(res.data);
    setAsked((n) => n + 1);
  }

  const lasted = s.startedAt ? s.lastActive - s.startedAt : null;
  const events = transcript?.events ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="session-title" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        <header className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="flex items-center gap-1 text-fg-2">
                  <ProviderGlyph provider={s.tool} size={12} />
                  {TOOL_NAME[s.tool]}
                </span>
                {s.active && (
                  <span className="chip chip-good">
                    <span className="live h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                    live
                  </span>
                )}
                <span className="font-mono text-faint">{sourceLabel(s)}</span>
              </div>
              <h2 id="session-title" className="mt-1.5 line-clamp-2 text-sm font-medium text-fg">
                {s.title ?? (shared ? "Untitled session" : "Title not shared")}
              </h2>
              <p className="mt-1 font-mono text-[11px] text-muted">
                {s.member.email} · {s.device.name} · {s.path}
                {s.branch ? ` · ${s.branch}` : ""}
              </p>
              <p className="font-mono text-[11px] text-faint">
                {s.startedAt ? `started ${formatAgo(now - s.startedAt)}` : ""}
                {` · last active ${formatAgo(now - s.lastActive)}`}
                {lasted !== null && lasted > 0 ? ` · ran ${formatCountdown(lasted)}` : ""}
              </p>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <Figure label="tokens" value={formatTokens(s.totals.tokens)} />
            <Figure label="written" value={formatTokens(s.totals.output)} />
            <Figure label="api value" value={s.totals.cost > 0 ? `≈ ${formatMoney(s.totals.cost)}` : "—"} />
            <Figure label="replies" value={s.totals.messages.toLocaleString()} />
            {s.subagents > 0 && <Figure label="subagents" value={String(s.subagents)} />}
          </div>
          <ul className="mt-2 space-y-0.5">
            {s.usage.map((u) => {
              const cost = costOf(u);
              return (
                <li key={u.model} className="flex justify-between gap-3 font-mono text-[11px] text-muted">
                  <span className="truncate">{u.model}</span>
                  <span className="shrink-0">
                    {formatTokens(rowTokens(u))} · in {formatTokens(u.input)} · out {formatTokens(u.output)} · cache {formatTokens(u.cacheRead + u.cacheWrite)}
                    {cost !== null ? ` · ≈ ${formatMoney(cost)}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {s.run && (
            <button type="button" onClick={() => onOpenRun(s.run!.id)} className="btn mt-3">
              <Icon name="terminal" />
              Started from the dashboard by {s.run.by ?? "a deleted account"}: open it
            </button>
          )}
        </header>

        <div className="min-h-40 flex-1 space-y-2.5 overflow-y-auto px-5 py-4" aria-live="polite">
          {!shared ? (
            <p className="text-sm text-muted">
              {s.device.name} does not share what its sessions say. Its owner can turn on <span className="text-fg-2">Share session content</span> in AI Cooldown there,
              under This machine, to let its conversations be read here.
            </p>
          ) : !transcript ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted">The conversation stays on {s.device.name} until someone asks for it. Its computer reads it from the CLI&apos;s log and sends it.</p>
              <button type="button" onClick={() => void ask(false)} disabled={asking} className="btn btn-primary">
                <Icon name="download" />
                {asking ? "Asking…" : "Show the conversation"}
              </button>
            </div>
          ) : (
            <>
              {events.map((e) => (
                <EventLine key={e.seq} event={e} />
              ))}
              {transcript.status === "pending" && (
                <p className="flex items-center gap-2 font-mono text-[11px] text-faint">
                  <Icon name="refresh" size={11} className="spin" /> asking {s.device.name}; computers answer on their next check-in, within a minute
                </p>
              )}
              {transcript.status === "ready" && events.length === 0 && <p className="text-sm text-muted">Nothing in this session&apos;s log to show.</p>}
              {transcript.status === "failed" && transcript.error && <EventLine event={{ seq: -1, at: 0, kind: "error", text: transcript.error }} />}
            </>
          )}
          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        {shared && transcript && transcript.status !== "pending" && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
            <p className="text-[11px] text-faint">
              {transcript.status === "ready" ? `Read from ${s.device.name} ${formatAgo(now - transcript.updatedAt)}; kept here a week.` : "The computer could not send it."}
            </p>
            <button type="button" onClick={() => void ask(true)} disabled={asking} className="btn">
              <Icon name="refresh" />
              {transcript.status === "ready" ? "Read it again" : "Try again"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="block text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="block font-mono text-sm tabular-nums text-fg">{value}</span>
    </span>
  );
}
