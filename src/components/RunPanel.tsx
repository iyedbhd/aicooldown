"use client";

import { useEffect, useRef, useState } from "react";
import { rowTokens, type Tool } from "@/lib/activity";
import { formatAgo, formatCountdown, formatMoney } from "@/lib/format";
import {
  cancelRun,
  CLAUDE_ALIASES,
  fetchRun,
  mayRunOn,
  REMOTE_HELP,
  REMOTE_LABEL,
  REMOTE_LEVELS,
  RUN_FINISHED,
  startRun,
  TOOL_NAME,
  unavailable,
  levelAllows,
  type Device,
  type RemoteLevel,
  type Run,
  type RunEvent,
  type Workspace,
} from "@/lib/team";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { StatusChip } from "./TeamBits";

const POLL_MS = 2_000;
const input = "w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";

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

type FormProps = {
  ws: Workspace;
  deviceId?: string;
  /** Continuing a conversation: the computer, project, mode and model are fixed to the run's. */
  continues?: Run;
  onStarted: (run: Run) => void;
  onCancel?: () => void;
};

/** Starts a Claude Code or Codex session on one of the computers the viewer may use. */
export function RunForm({ ws, deviceId, continues, onStarted, onCancel }: FormProps) {
  const devices = allDevices(ws).filter((d) => mayRunOn(ws, d));
  const firstReady = devices.find((d) => !unavailable(d));
  const [device, setDevice] = useState(continues?.deviceId ?? deviceId ?? firstReady?.id ?? devices[0]?.id ?? "");
  const current = devices.find((d) => d.id === device);
  const projects = projectsOn(current);
  const [tool, setTool] = useState<Tool>(continues?.tool ?? "claude");
  const [project, setProject] = useState(continues?.project ?? projects[0]?.path ?? "");
  const [mode, setMode] = useState<RemoteLevel>(continues?.mode ?? "read");
  const [model, setModel] = useState<string>(continues?.model ?? "");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = current ? unavailable(current) : "no computer";
  const modes = REMOTE_LEVELS.filter((l) => current && levelAllows(current.remote, l));

  function pickDevice(id: string) {
    setDevice(id);
    const next = devices.find((d) => d.id === id);
    setProject(projectsOn(next)[0]?.path ?? "");
    if (next && !levelAllows(next.remote, mode)) setMode("read");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await startRun({ deviceId: device, tool, project, prompt, mode, model: model || null, resume: continues?.sessionId ?? null });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setPrompt("");
    onStarted(res.data.run);
  }

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted">
        No computers to run on yet. Open AI Cooldown on a computer, sign in, and press <span className="text-fg-2">Connect this computer</span> under This machine. Its owner
        chooses there what remote sessions may do.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {!continues && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className="eyebrow">run with</span>
            <div role="radiogroup" aria-label="CLI" className="mt-1 flex gap-2">
              {(["claude", "codex"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tool === t}
                  onClick={() => {
                    setTool(t);
                    setModel("");
                  }}
                  className={`btn ${tool === t ? "btn-accent" : ""}`}
                >
                  <ProviderGlyph provider={t} size={14} />
                  {TOOL_NAME[t]}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="eyebrow">computer</span>
            <select value={device} onChange={(e) => pickDevice(e.target.value)} className={`mt-1 ${input}`}>
              {devices.map((d) => {
                const why = unavailable(d);
                const owner = ws.members.find((m) => m.id === d.userId);
                return (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {owner && owner.id !== ws.me.id ? ` · ${owner.email}` : ""}
                    {why ? ` (${why})` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow">project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)} className={`mt-1 ${input}`} disabled={projects.length === 0}>
              {projects.length === 0 && <option value="">no projects reported yet</option>}
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name} · {p.path}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow">{tool === "claude" ? "claude may" : "codex may"}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as RemoteLevel)} className={`mt-1 ${input}`} disabled={modes.length === 0}>
              {modes.length === 0 && <option value="read">nothing: remote sessions are off there</option>}
              {modes.map((l) => (
                <option key={l} value={l}>
                  {REMOTE_LABEL[l]}
                </option>
              ))}
            </select>
            {modes.length > 0 && <span className="mt-1 block text-[11px] text-faint">{REMOTE_HELP[mode]}</span>}
          </label>
          <label className="block">
            <span className="eyebrow">model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={`mt-1 ${input}`}>
              <option value="">{TOOL_NAME[tool]}&apos;s default</option>
              {modelsOn(current, tool).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className="block">
        <span className="eyebrow">{continues ? "reply" : `what should ${TOOL_NAME[tool]} do?`}</span>
        <textarea
          required
          rows={continues ? 3 : 5}
          maxLength={20_000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={continues ? "Follow up in the same conversation…" : "e.g. Run the tests and explain any failures."}
          className={`mt-1 ${input} resize-y font-mono text-[13px]`}
        />
      </label>
      {error && <p className="border-l-2 border-rose-500/70 pl-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-faint">
          {blocked
            ? `${current?.name ?? "That computer"} cannot take a session right now: ${blocked}.`
            : `Runs ${TOOL_NAME[tool]} on ${current?.name} as the account its CLI is signed in with${current?.logins[tool] ? ` (${current.logins[tool]})` : ""}.`}
        </p>
        <div className="flex gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className="btn">
              Cancel
            </button>
          )}
          <button type="submit" disabled={busy || Boolean(blocked) || !project || !prompt.trim()} className="btn btn-primary">
            <Icon name="play" />
            {busy ? "Starting…" : continues ? "Continue" : "Start session"}
          </button>
        </div>
      </div>
    </form>
  );
}

const EVENT_STYLE: Record<RunEvent["kind"], string> = {
  user: "whitespace-pre-wrap rounded-lg border border-line bg-panel-3 px-3 py-2 text-sm leading-relaxed text-fg",
  text: "whitespace-pre-wrap text-sm leading-relaxed text-fg",
  result: "whitespace-pre-wrap rounded-lg border-l-2 border-emerald-500/70 bg-emerald-500/5 px-3 py-2 text-sm leading-relaxed text-fg",
  tool: "flex items-start gap-2 font-mono text-[12px] text-fg-2",
  output: "max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted",
  error: "whitespace-pre-wrap rounded-md bg-rose-500/10 px-3 py-2 font-mono text-[12px] text-rose-700 dark:text-rose-200",
  info: "font-mono text-[11px] text-faint",
};

/** One step of a session: a prompt, what the model said, a tool call and its output, or a note. */
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

type PanelProps = { runId: string; ws: Workspace; now: number; onClose: () => void; onOpen: (run: Run) => void };

/** One remote session, live: its output as it comes, cancel while it runs, continue the conversation when it is done. */
export function RunPanel({ runId, ws, now, onClose, onOpen }: PanelProps) {
  const [run, setRun] = useState<Run | null>(ws.runs.find((r) => r.id === runId) ?? null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // One panel per run (the page keys it by run id), so it starts empty.
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const res = await fetchRun(runId, lastSeq.current);
      if (!alive) return;
      if (!res.ok) {
        setError(res.error);
      } else {
        setError(null);
        setRun(res.data.run);
        if (res.data.events.length) {
          lastSeq.current = res.data.events[res.data.events.length - 1].seq;
          setEvents((prev) => [...prev, ...res.data.events]);
        }
        // Keep reading until it is over and nothing more is left to fetch.
        if (RUN_FINISHED.includes(res.data.run.status) && res.data.events.length < 500) return;
      }
      timer = setTimeout(() => void poll(), res.ok && res.data.events.length >= 500 ? 0 : POLL_MS);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId]);

  // Follow the output while the reader is at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [events]);

  const device = run ? allDevices(ws).find((d) => d.id === run.deviceId) : undefined;
  const finished = run ? RUN_FINISHED.includes(run.status) : false;
  const canContinue = Boolean(run && finished && run.sessionId && device && mayRunOn(ws, device));
  const took = run?.startedAt ? (run.finishedAt ?? now) - run.startedAt : null;

  async function cancel() {
    if (!run) return;
    setCancelling(true);
    const res = await cancelRun(run.id);
    setCancelling(false);
    if (!res.ok) setError(res.error);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="run-title" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        <header className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {run && <StatusChip status={run.status} />}
                {run && (
                  <span className="flex items-center gap-1 text-[11px] text-fg-2">
                    <ProviderGlyph provider={run.tool} size={12} />
                    {TOOL_NAME[run.tool]}
                  </span>
                )}
                <span className="font-mono text-[11px] text-faint">
                  {run ? `${run.deviceName} · ${run.project}` : "…"}
                </span>
              </div>
              <h2 id="run-title" className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm font-medium text-fg">
                {run?.prompt ?? "Loading…"}
              </h2>
              {run && (
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {run.by ?? "a deleted account"} · {REMOTE_LABEL[run.mode].toLowerCase()}
                  {run.model ? ` · ${run.model}` : ""} · started {formatAgo(now - run.createdAt)}
                  {took !== null && ` · ${finished ? "took" : "running for"} ${formatCountdown(took)}`}
                  {run.result?.costUsd !== undefined && ` · ${formatMoney(run.result.costUsd)}`}
                  {run.result?.turns !== undefined && ` · ${run.result.turns} turns`}
                  {run.resume && " · continues a conversation"}
                </p>
              )}
            </div>
            <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div ref={scroller} className="min-h-40 flex-1 space-y-2.5 overflow-y-auto px-5 py-4" aria-live="polite">
          {run?.status === "queued" && (
            <p className="font-mono text-[11px] text-muted">
              Waiting for {run.deviceName} to pick it up. Computers check in every few seconds while remote sessions are on.
            </p>
          )}
          {events.map((e) => (
            <EventLine key={e.seq} event={e} />
          ))}
          {run?.status === "running" && (
            <p className="flex items-center gap-2 font-mono text-[11px] text-faint">
              <Icon name="refresh" size={11} className="spin" /> working
            </p>
          )}
          {run?.status === "failed" && run.result?.error && !events.some((e) => e.kind === "error" && e.text === run.result?.error) && (
            <EventLine event={{ seq: -1, at: 0, kind: "error", text: run.result.error }} />
          )}
          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        <footer className="border-t border-line px-5 py-3">
          {run && !finished && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-faint">Output appears as the computer sends it.</p>
              <button type="button" onClick={() => void cancel()} disabled={cancelling} className="btn border-rose-500/40 text-rose-600 dark:text-rose-400">
                <Icon name="stop" />
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          )}
          {canContinue && run && <RunForm ws={ws} continues={run} onStarted={onOpen} />}
          {finished && !canContinue && <p className="text-[11px] text-faint">{run?.sessionId ? "Only its computer's owner or a team admin can continue it." : "This session cannot be continued."}</p>}
        </footer>
      </div>
    </div>
  );
}
