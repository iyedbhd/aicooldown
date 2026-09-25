"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTokens, rowTokens, type Tool } from "@/lib/activity";
import { formatAgo, formatCountdown, formatMoney } from "@/lib/format";
import { notifyIfEnabled } from "@/lib/notify";
import { costOf } from "@/lib/pricing";
import {
  cancelRun,
  chatBlocked,
  CLAUDE_ALIASES,
  fetchRun,
  fetchTranscript,
  heatDevice,
  levelAllows,
  mayRunOn,
  MAX_PROMPT,
  REMOTE_HELP,
  REMOTE_LABEL,
  REMOTE_LEVELS,
  requestTranscript,
  RUN_FINISHED,
  sharesWith,
  startRun,
  TOOL_NAME,
  unavailable,
  type Device,
  type RemoteLevel,
  type Run,
  type RunEvent,
  type Transcript,
  type Workspace,
} from "@/lib/team";
import { sourceLabel, type SessionRow } from "@/lib/team-stats";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { StatusChip } from "./TeamBits";

/** What the chat opens on: one of the sessions the computers reported, a remote session, or a new conversation. */
export type ChatTarget = { kind: "session"; key: string } | { kind: "run"; id: string } | { kind: "new"; deviceId?: string };

/** A conversation on one computer: its CLI, its project, and its session id once it has one. */
type Thread = { deviceId: string; tool: Tool; project: string; sessionId: string | null };

const POLL_MS = 1_500;
const TRANSCRIPT_POLL_MS = 2_000;
/** While a conversation is open, its computer is told every so often to check in every few seconds. */
const HEAT_MS = 60_000;

const field = "rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-xs text-fg focus:border-muted focus:outline-none";

const allDevices = (ws: Workspace) => ws.members.flatMap((m) => m.devices);

/** Each project a computer reported, once, most recently active first. */
function projectsOn(device: Device | undefined) {
  const seen = new Set<string>();
  return (device?.activity?.projects ?? [])
    .slice()
    .sort((a, b) => b.lastActive - a.lastActive)
    .filter((p) => !seen.has(p.path) && Boolean(seen.add(p.path)));
}

/** The models a computer's CLI used lately, most used first; Claude Code's aliases first for it. */
function modelsOn(device: Device | undefined, tool: Tool): string[] {
  const used = new Map<string, number>();
  for (const p of device?.activity?.projects ?? []) {
    if (p.tool !== tool) continue;
    for (const r of p.rows) used.set(r.model, (used.get(r.model) ?? 0) + rowTokens(r));
  }
  const seen = [...used].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  return tool === "claude" ? [...CLAUDE_ALIASES, ...seen] : seen;
}

function threadOf(target: ChatTarget, ws: Workspace, sessions: SessionRow[]): Thread | null {
  if (target.kind === "session") {
    const s = sessions.find((x) => x.key === target.key);
    return s ? { deviceId: s.device.id, tool: s.tool, project: s.path, sessionId: s.id } : null;
  }
  if (target.kind === "run") {
    const r = ws.runs.find((x) => x.id === target.id);
    return r ? { deviceId: r.deviceId, tool: r.tool, project: r.project, sessionId: r.sessionId ?? r.resume } : null;
  }
  return null;
}

/** What a message may do by default: what the conversation last used, else edits where the computer allows them. */
function defaultMode(device: Device | undefined, last: Run | undefined): RemoteLevel {
  const allowed = REMOTE_LEVELS.filter((l) => device && levelAllows(device.remote, l));
  if (last && allowed.includes(last.mode)) return last.mode;
  return allowed.includes("edit") ? "edit" : (allowed[allowed.length - 1] ?? "read");
}

type Props = {
  ws: Workspace;
  sessions: SessionRow[];
  now: number;
  target: ChatTarget;
  onClose: () => void;
  /** Something changed that the workspace shows: a session started. */
  onChanged: () => void;
};

/**
 * A Claude Code or Codex conversation on one of the computers, as a chat: what
 * was said so far (read from the computer's log, where it shares that with the
 * viewer), what was sent from here and the replies as they come, and a box to
 * say something next, which the computer runs as the next turn of the same
 * conversation. Works the same for conversations started in a terminal, an
 * IDE, the Claude or Codex desktop apps, or from here.
 */
export function ChatPanel({ ws, sessions, now, target, onClose, onChanged }: Props) {
  const devices = allDevices(ws);
  const usable = devices.filter((d) => mayRunOn(ws, d));
  const [thread, setThread] = useState<Thread | null>(() => threadOf(target, ws, sessions));
  const [draft, setDraft] = useState(() => {
    const deviceId = (target.kind === "new" && target.deviceId) || usable.find((d) => !unavailable(d))?.id || usable[0]?.id || "";
    return { deviceId, tool: "claude" as Tool, project: projectsOn(devices.find((d) => d.id === deviceId))[0]?.path ?? "" };
  });
  const [mine, setMine] = useState<Run[]>(() => (target.kind === "run" ? ws.runs.filter((r) => r.id === target.id) : []));
  const [latest, setLatest] = useState<Record<string, Run>>({});
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({});
  const [drained, setDrained] = useState<Record<string, boolean>>({});
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [asked, setAsked] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RemoteLevel | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const seqs = useRef<Record<string, number>>({});
  const statuses = useRef<Record<string, string>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const deviceId = thread?.deviceId ?? draft.deviceId;
  const tool = thread?.tool ?? draft.tool;
  const project = thread?.project ?? draft.project;
  const device = devices.find((d) => d.id === deviceId);
  const own = device?.userId === ws.me.id;

  // This conversation's remote sessions: those started here, and any on its session id.
  const mineIds = useMemo(() => new Set(mine.map((r) => r.id)), [mine]);
  const pool = useMemo(() => {
    const byId = new Map<string, Run>();
    for (const r of [...ws.runs, ...mine]) byId.set(r.id, latest[r.id] ?? r);
    return [...byId.values()].filter((r) => r.deviceId === deviceId && r.tool === tool);
  }, [ws.runs, mine, latest, deviceId, tool]);
  const sessionId = thread?.sessionId ?? pool.find((r) => mineIds.has(r.id) && r.sessionId)?.sessionId ?? null;
  const runs = useMemo(
    () => pool.filter((r) => mineIds.has(r.id) || (sessionId !== null && (r.sessionId === sessionId || r.resume === sessionId))).sort((a, b) => a.createdAt - b.createdAt),
    [pool, mineIds, sessionId],
  );
  const session = sessionId ? sessions.find((s) => s.device.id === deviceId && s.tool === tool && s.id === sessionId) : undefined;
  const active = runs.find((r) => !RUN_FINISHED.includes(r.status));
  const last = runs[runs.length - 1];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !box.current?.value && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // While the conversation is open its computer checks in every few seconds, so a message starts at once.
  useEffect(() => {
    if (!deviceId) return;
    void heatDevice(deviceId);
    const timer = setInterval(() => void heatDevice(deviceId), HEAT_MS);
    return () => clearInterval(timer);
  }, [deviceId]);

  // Each remote session's output, as it comes; a finished one once, all of it.
  const wanted = runs
    .filter((r) => !drained[r.id])
    .map((r) => r.id)
    .join(",");
  useEffect(() => {
    if (!wanted) return;
    const ids = wanted.split(",");
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      for (const id of ids) {
        const res = await fetchRun(id, seqs.current[id] ?? 0);
        if (!alive) return;
        if (!res.ok) continue;
        const { run, events: got } = res.data;
        if (got.length) {
          seqs.current[id] = got[got.length - 1].seq;
          setEvents((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), ...got] }));
        }
        const before = statuses.current[id];
        statuses.current[id] = run.status;
        setLatest((prev) => ({ ...prev, [id]: run }));
        if (RUN_FINISHED.includes(run.status)) {
          if (before && !RUN_FINISHED.includes(before as Run["status"]) && document.hidden) {
            const said = [...(got.length ? got : [])].reverse().find((e) => e.kind === "result" || e.kind === "text")?.text ?? run.result?.error ?? run.status;
            notifyIfEnabled(`${TOOL_NAME[run.tool]} ${run.status === "done" ? "replied" : run.status} on ${run.deviceName}`, said.slice(0, 160), `run:${id}`);
          }
          if (got.length < 500) setDrained((prev) => ({ ...prev, [id]: true }));
        }
      }
      if (alive) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted]);

  // What was said before: read from the computer's log where it shares that with the viewer, asked for the first time if nobody has.
  const readable = Boolean(device && session && sharesWith(device.share, own));
  useEffect(() => {
    if (!readable || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (first: boolean) =>
      void fetchTranscript(deviceId, tool, sessionId).then(async (res) => {
        if (!alive || !res.ok) return;
        let t = res.data;
        if (!t && first) {
          const ask = await requestTranscript(deviceId, tool, sessionId, false);
          if (!alive || !ask.ok) return;
          t = ask.data;
        }
        setTranscript(t);
        if (t?.status === "pending") timer = setTimeout(() => poll(false), TRANSCRIPT_POLL_MS);
      });
    poll(true);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [readable, deviceId, tool, sessionId, asked]);

  // Follow the conversation while the reader is at the bottom.
  const size = runs.reduce((n, r) => n + (events[r.id]?.length ?? 0) + 1, transcript?.events.length ?? 0);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [size]);

  // Remote sessions the transcript already has were asked for before it was read.
  const cutoff = transcript && transcript.events.length > 0 ? transcript.requestedAt : 0;
  const shownRuns = runs.filter((r) => r.createdAt > cutoff);
  // Started from here: the conversation's first turn was a remote session (continuing one of the computer's own does not count).
  const fromHere = sessionId === null || runs.some((r) => r.sessionId === sessionId && r.resume === null);
  const blocked = !device ? "Pick a computer to run on." : chatBlocked(ws, device, tool, fromHere);
  const chosenMode = mode ?? defaultMode(device, last);
  // A conversation's own model, not Codex's placeholder from before its first turn said which.
  const sessionModel = session?.model && session.model !== "codex" && session.model !== "unknown" ? session.model : null;
  const chosenModel = model ?? last?.model ?? sessionModel ?? "";
  const modes = REMOTE_LEVELS.filter((l) => device && levelAllows(device.remote, l));
  const projects = projectsOn(device);

  async function send() {
    const text = prompt.trim();
    if (!text || !device || blocked || active || !project) return;
    setSending(true);
    setError(null);
    const res = await startRun({ deviceId, tool, project, prompt: text, mode: chosenMode, model: chosenModel || null, resume: sessionId });
    setSending(false);
    if (!res.ok) return setError(res.error);
    if (!thread) setThread({ deviceId, tool, project, sessionId });
    setMine((prev) => [...prev, res.data.run]);
    setPrompt("");
    onChanged();
  }

  async function stop() {
    if (!active) return;
    const res = await cancelRun(active.id);
    if (!res.ok) setError(res.error);
  }

  async function readAgain() {
    if (!sessionId) return;
    const res = await requestTranscript(deviceId, tool, sessionId, true);
    if (!res.ok) return setError(res.error);
    setTranscript(res.data);
    setAsked((n) => n + 1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter starts a new line, except on touch screens, where the button sends.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      void send();
    }
  }

  const title = session?.title ?? (thread ? (runs[0]?.prompt ?? projects.find((p) => p.path === project)?.name ?? "Conversation") : "New conversation");

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="chat-title" className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-panel shadow-2xl sm:h-[88vh] sm:rounded-2xl sm:border sm:border-line">
        <header className="border-b border-line px-4 py-3 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="flex items-center gap-1 text-fg-2">
                  <ProviderGlyph provider={tool} size={12} />
                  {TOOL_NAME[tool]}
                </span>
                {session?.active && !active && (
                  <span className="chip chip-good">
                    <span className="live h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                    live
                  </span>
                )}
                {active && <StatusChip status={active.status} />}
                {session && <span className="font-mono text-faint">{sourceLabel(session)}</span>}
              </div>
              <h2 id="chat-title" className="mt-1 line-clamp-2 text-sm font-medium text-fg">
                {title}
              </h2>
              {thread && (
                <p className="truncate font-mono text-[11px] text-muted">
                  {device?.name ?? "computer"} · {project}
                  {session?.branch ? ` · ${session.branch}` : ""}
                  {device && device.userId !== ws.me.id ? ` · ${ws.members.find((m) => m.id === device.userId)?.email ?? ""}` : ""}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {session && (
                <button type="button" onClick={() => setDetails((d) => !d)} aria-expanded={details} className="rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg">
                  details
                </button>
              )}
              <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
          {details && session && <SessionDetails s={session} now={now} />}
          {!thread && <NewChatFields ws={ws} usable={usable} draft={draft} setDraft={setDraft} />}
        </header>

        <div ref={scroller} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
          {sessionId && !readable && session && (
            <p className="text-[12px] text-faint">
              {device?.share === "off" || !device
                ? `What was said before stays on ${device?.name ?? "the computer"}: it does not share session content.`
                : `${device.name} shares what its sessions say with its owner only.`}{" "}
              Messages sent from here show below.
            </p>
          )}
          {readable && !transcript && <p className="font-mono text-[11px] text-faint">asking {device?.name} for the conversation…</p>}
          {transcript?.events.map((e) => (
            <EventLine key={`t${e.seq}`} event={e} />
          ))}
          {transcript?.status === "pending" && (
            <p className="flex items-center gap-2 font-mono text-[11px] text-faint">
              <Icon name="refresh" size={11} className="spin" /> reading it on {device?.name}; computers answer within seconds while this is open
            </p>
          )}
          {transcript?.status === "failed" && transcript.error && <EventLine event={{ seq: -1, at: 0, kind: "error", text: transcript.error }} />}
          {transcript && transcript.status !== "pending" && (
            <button type="button" onClick={() => void readAgain()} className="flex items-center gap-1.5 font-mono text-[11px] text-faint hover:text-fg">
              <Icon name="refresh" size={11} /> read {transcript.status === "ready" ? `${formatAgo(now - transcript.updatedAt)}; read it again` : "it again"}
            </button>
          )}
          {shownRuns.map((r) => (
            <RunBlock key={r.id} run={r} events={events[r.id] ?? []} team={Boolean(ws.team)} now={now} />
          ))}
          {!thread && runs.length === 0 && (
            <p className="text-sm text-muted">
              Pick a computer, a CLI and a project above, then say what to do. The conversation continues here: send the next message when the reply is in.
            </p>
          )}
        </div>

        <footer className="border-t border-line px-4 py-3 sm:px-5">
          {session?.active && !active && !blocked && (
            <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">This conversation is open on {device?.name} right now: a message from here runs alongside it.</p>
          )}
          {blocked ? (
            <p className="text-[12px] text-muted">{blocked}</p>
          ) : (
            <>
              <textarea
                ref={box}
                rows={3}
                maxLength={MAX_PROMPT}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={active ? "The reply is on its way…" : sessionId ? "Reply in this conversation…" : `What should ${TOOL_NAME[tool]} do?`}
                aria-label="Message"
                className="w-full resize-none rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select value={chosenMode} onChange={(e) => setMode(e.target.value as RemoteLevel)} aria-label="What it may do" title={REMOTE_HELP[chosenMode]} className={field}>
                    {modes.map((l) => (
                      <option key={l} value={l}>
                        {REMOTE_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  <select value={chosenModel} onChange={(e) => setModel(e.target.value)} aria-label="Model" className={`${field} max-w-44`}>
                    <option value="">{TOOL_NAME[tool]}&apos;s default</option>
                    {[...new Set([...(chosenModel ? [chosenModel] : []), ...modelsOn(device, tool)])].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="hidden font-mono text-[10px] text-faint sm:inline">{device?.logins[tool] ? `as ${device.logins[tool]}` : ""}</span>
                </div>
                {active ? (
                  <button type="button" onClick={() => void stop()} className="btn border-rose-500/40 text-rose-600 dark:text-rose-400">
                    <Icon name="stop" />
                    Stop
                  </button>
                ) : (
                  <button type="button" onClick={() => void send()} disabled={sending || !prompt.trim() || !project} className="btn btn-primary">
                    <Icon name="play" />
                    {sending ? "Sending…" : "Send"}
                  </button>
                )}
              </div>
            </>
          )}
          {error && <p className="mt-2 border-l-2 border-rose-500/70 pl-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        </footer>
      </div>
    </div>
  );
}

type Draft = { deviceId: string; tool: Tool; project: string };

/** A new conversation: on which computer, with which CLI, in which project. */
function NewChatFields({ ws, usable, draft, setDraft }: { ws: Workspace; usable: Device[]; draft: Draft; setDraft: (d: Draft) => void }) {
  const device = usable.find((d) => d.id === draft.deviceId);
  const projects = projectsOn(device);
  if (usable.length === 0) {
    return (
      <p className="mt-2 text-[12px] text-muted">
        No computers to run on yet. Open AI Cooldown on a computer, sign in, and press <span className="text-fg-2">Connect this computer</span> under This machine. Its owner chooses
        there what remote sessions may do.
      </p>
    );
  }
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      <select
        value={draft.deviceId}
        onChange={(e) => setDraft({ ...draft, deviceId: e.target.value, project: projectsOn(usable.find((d) => d.id === e.target.value))[0]?.path ?? "" })}
        aria-label="Computer"
        className={field}
      >
        {usable.map((d) => {
          const owner = ws.members.find((m) => m.id === d.userId);
          const why = unavailable(d);
          return (
            <option key={d.id} value={d.id}>
              {d.name}
              {owner && owner.id !== ws.me.id ? ` · ${owner.email}` : ""}
              {why ? ` (${why})` : ""}
            </option>
          );
        })}
      </select>
      <div role="radiogroup" aria-label="CLI" className="flex gap-1">
        {(["claude", "codex"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={draft.tool === t}
            onClick={() => setDraft({ ...draft, tool: t })}
            title={device ? (unavailable(device, t) ?? undefined) : undefined}
            className={`btn ${draft.tool === t ? "btn-accent" : ""}`}
          >
            <ProviderGlyph provider={t} size={13} />
            {TOOL_NAME[t]}
          </button>
        ))}
      </div>
      <select value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} aria-label="Project" className={`${field} max-w-full`} disabled={projects.length === 0}>
        {projects.length === 0 && <option value="">no projects reported yet</option>}
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name} · {p.path}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The CLIs end with their last reply again as the result: shown once, as the result. */
function withoutEcho(events: RunEvent[]): RunEvent[] {
  const results = new Set(events.filter((e) => e.kind === "result").map((e) => e.text));
  return events.filter((e) => !(e.kind === "text" && results.has(e.text)));
}

/** A message sent from here and what came back: the prompt, the reply as it streams, and how it ended. */
function RunBlock({ run: r, events, team, now }: { run: Run; events: RunEvent[]; team: boolean; now: number }) {
  const took = r.startedAt ? (r.finishedAt ?? now) - r.startedAt : null;
  return (
    <div className="space-y-2.5">
      <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md border border-line bg-panel-3 px-3 py-2">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{r.prompt}</p>
        <p className="mt-1 text-right font-mono text-[10px] text-faint">
          {team ? `${r.by ?? "deleted account"} · ` : ""}
          {REMOTE_LABEL[r.mode].toLowerCase()}
          {r.model ? ` · ${r.model}` : ""} · {formatAgo(now - r.createdAt)}
        </p>
      </div>
      {r.status === "queued" && <p className="font-mono text-[11px] text-muted">waiting for {r.deviceName} to pick it up…</p>}
      {withoutEcho(events).map((e) => (
        <EventLine key={e.seq} event={e} />
      ))}
      {r.status === "running" && (
        <p className="flex items-center gap-2 font-mono text-[11px] text-faint">
          <Icon name="refresh" size={11} className="spin" /> working
        </p>
      )}
      {r.status === "failed" && r.result?.error && !events.some((e) => e.kind === "error" && e.text === r.result?.error) && (
        <EventLine event={{ seq: -1, at: 0, kind: "error", text: r.result.error }} />
      )}
      {RUN_FINISHED.includes(r.status) && (
        <p className="font-mono text-[10px] text-faint">
          {r.status}
          {took !== null ? ` · ${formatCountdown(took)}` : ""}
          {r.result?.costUsd !== undefined ? ` · ≈ ${r.result.costUsd > 0 && r.result.costUsd < 0.01 ? "<$0.01" : formatMoney(r.result.costUsd)}` : ""}
          {r.result?.turns !== undefined ? ` · ${r.result.turns} turn${r.result.turns === 1 ? "" : "s"}` : ""}
        </p>
      )}
    </div>
  );
}

/** Where and when a session ran, and what it used, per model. */
function SessionDetails({ s, now }: { s: SessionRow; now: number }) {
  const lasted = s.startedAt ? s.lastActive - s.startedAt : null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-line bg-panel-2 px-3 py-2">
      <p className="font-mono text-[11px] text-muted">
        {s.startedAt ? `started ${formatAgo(now - s.startedAt)} · ` : ""}last active {formatAgo(now - s.lastActive)}
        {lasted !== null && lasted > 0 ? ` · ran ${formatCountdown(lasted)}` : ""}
        {s.subagents > 0 ? ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}` : ""}
      </p>
      <p className="font-mono text-[11px] text-fg-2">
        {formatTokens(s.totals.tokens)} tokens · {formatTokens(s.totals.output)} written · {s.totals.cost > 0 ? `≈ ${formatMoney(s.totals.cost)}` : "—"} · {s.totals.messages.toLocaleString()} replies
      </p>
      <ul className="space-y-0.5">
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
    </div>
  );
}

const EVENT_STYLE: Record<RunEvent["kind"], string> = {
  user: "ml-auto max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-line bg-panel-3 px-3 py-2 text-sm leading-relaxed text-fg",
  text: "whitespace-pre-wrap text-sm leading-relaxed text-fg",
  result: "whitespace-pre-wrap rounded-lg border-l-2 border-emerald-500/70 bg-emerald-500/5 px-3 py-2 text-sm leading-relaxed text-fg",
  tool: "flex items-start gap-2 font-mono text-[12px] text-fg-2",
  output: "max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted",
  error: "whitespace-pre-wrap rounded-md bg-rose-500/10 px-3 py-2 font-mono text-[12px] text-rose-700 dark:text-rose-200",
  info: "font-mono text-[11px] text-faint",
};

/** One step of a conversation: a prompt, what the model said, a tool call and its output, or a note. */
export function EventLine({ event }: { event: RunEvent }) {
  if (event.kind === "tool") {
    return (
      <div className={EVENT_STYLE.tool}>
        <Icon name="terminal" size={12} className="mt-0.5 shrink-0 text-faint" />
        <span className="break-all">{event.text}</span>
      </div>
    );
  }
  return <div className={EVENT_STYLE[event.kind]}>{event.text}</div>;
}
