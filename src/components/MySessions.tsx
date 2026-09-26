"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SessionUser } from "@/lib/session";
import { fetchWorkspace, mayRunOn, unavailable, type Workspace } from "@/lib/team";
import { allSessions, liveNow } from "@/lib/team-stats";
import { ChatPanel, type ChatTarget } from "./ChatPanel";
import { Icon } from "./Icon";
import { RefreshButton, useRefresh } from "./RefreshButton";
import { RunLine, SessionLine } from "./TeamSessions";

/** How often the list is read again while the page is in view: only for someone with a computer connected. */
const POLL_MS = 60_000;
/** Sessions shown here before "all of them". */
const SHOWN = 6;

/**
 * Your own computers' Claude Code and Codex sessions on the first page: what
 * runs now and the latest, each opening as the chat it is, and a new chat on
 * any of your computers, without going to the Team page. Only your computers;
 * a team's are on the Team page. Nothing shows until a computer is connected.
 */
export function MySessions({ user, now }: { user: SessionUser | null; now: number }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  /** When the list on screen was read. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatTarget | null>(null);

  /** Reads the list again; returns why it could not. */
  const load = useCallback(async () => {
    const res = await fetchWorkspace("me");
    if (!res.ok) return res.error;
    setWs(res.data);
    setLoadedAt(Date.now());
    return null;
  }, []);
  const [refreshing, refresh] = useRefresh(load);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    const read = async () => {
      const res = await fetchWorkspace("me");
      if (alive && res.ok) {
        setWs(res.data);
        setLoadedAt(Date.now());
      }
      return res.ok ? res.data : null;
    };
    void read().then((first) => {
      // Followed only while there is something to follow: most people here just watch their limits.
      if (alive && first?.members[0]?.devices.length) poll = setInterval(() => document.visibilityState === "visible" && void read(), POLL_MS);
    });
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [user]);

  const mine = ws && user && ws.me.id === user.id ? ws : null;
  const devices = mine?.members[0]?.devices ?? [];
  if (!mine || devices.length === 0) return null;
  const sessions = allSessions(mine, now);
  const live = liveNow(mine, sessions);
  const liveCount = live.sessions.length + live.runs.length;
  const shown = sessions.slice(0, Math.max(0, SHOWN - live.runs.length));
  const canChat = devices.some((d) => mayRunOn(mine, d));

  return (
    <section className="fade-in mt-6 rounded-2xl border border-line bg-panel" aria-label="Your sessions">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-medium text-fg-2">
          <Icon name="terminal" size={14} />
          Your sessions
          {liveCount > 0 && (
            <span className="chip chip-good">
              <span className="live h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              {liveCount} live
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <RefreshButton label="Refresh your sessions" busy={refreshing} onRefresh={() => void refresh()} updatedAt={loadedAt} now={now} />
          <Link href="/team?team=me&tab=sessions" className="btn">
            All sessions
          </Link>
          {canChat && (
            <button type="button" onClick={() => setChat({ kind: "new" })} className="btn btn-primary">
              <Icon name="terminal" />
              New chat
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
        {devices.map((d) => {
          const why = unavailable(d);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => setChat({ kind: "new", deviceId: d.id })}
              title={why ? `${d.name}: ${why}` : `Start a chat on ${d.name}`}
              className="chip transition hover:brightness-95"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${d.online ? "bg-emerald-500" : "bg-faint"}`} aria-hidden />
              <Icon name="monitor" size={11} />
              {d.name}
              <span className="text-faint">{d.online ? (why ?? "ready") : why}</span>
            </button>
          );
        })}
      </div>

      {shown.length + live.runs.length === 0 ? (
        <p className="px-4 py-5 text-center text-sm text-muted">No Claude Code or Codex sessions on your computers in the last 30 days. Start one with New chat.</p>
      ) : (
        <ul className="divide-y divide-line">
          {live.runs.map((r) => (
            <RunLine key={r.id} run={r} team={false} now={now} onOpen={() => setChat({ kind: "run", id: r.id })} />
          ))}
          {shown.map((s) => (
            <SessionLine key={s.key} s={s} showMember={false} now={now} onOpen={() => setChat({ kind: "session", key: s.key })} />
          ))}
        </ul>
      )}
      {sessions.length > shown.length && (
        <Link href="/team?team=me&tab=sessions" className="block border-t border-line px-4 py-2 text-center text-xs text-muted hover:bg-panel-2 hover:text-fg">
          All {sessions.length} sessions →
        </Link>
      )}

      {chat && (
        <ChatPanel
          key={chat.kind === "new" ? `new:${chat.deviceId ?? ""}` : chat.kind === "run" ? chat.id : chat.key}
          ws={mine}
          sessions={sessions}
          now={now}
          target={chat}
          onClose={() => setChat(null)}
          onChanged={() => void load()}
          onShare={async () => undefined}
        />
      )}
    </section>
  );
}
