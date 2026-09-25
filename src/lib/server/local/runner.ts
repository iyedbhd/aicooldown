import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { costOf } from "@/lib/pricing";
import type { RunEventKind, RunJob, RunResult, RunStatus } from "@/lib/team";
import { codexModel } from "./activity";
import { cliBin, liveEnv } from "./cli";
import { describeTool, outputText } from "./transcript";

/*
 * Runs a remote session through the Claude Code or Codex CLI on this computer,
 * in the project's folder, as the login the CLI uses now, with the
 * permissions the session asked for, which the caller already checked against
 * what this computer allows. The prompt goes in on stdin, never on the command
 * line, so nothing in it reaches a shell. Output streams back as events while
 * it runs.
 */

/** A session may run this long before it is stopped. */
const TIMEOUT_MS = 30 * 60_000;
/** How often output is sent while it runs. */
const FLUSH_MS = 1_500;
const MAX_TEXT = 4_000;
const MAX_OUTPUT = 1_500;

type Level = "read" | "edit" | "full";

/** Claude Code: plan mode reads, acceptEdits edits files, bypassPermissions runs anything. */
const CLAUDE_MODE: Record<Level, string> = { read: "plan", edit: "acceptEdits", full: "bypassPermissions" };
/** Codex: its read-only sandbox, its workspace sandbox (edits and commands in the project, no network), or none. */
const CODEX_SANDBOX: Record<Level, string[]> = {
  read: ["--sandbox", "read-only"],
  edit: ["--sandbox", "workspace-write"],
  full: ["--dangerously-bypass-approvals-and-sandbox"],
};

/** The CLI's arguments: fixed flags and values checked before, the prompt read from stdin. */
function command(job: RunJob): string[] {
  const level = job.mode as Level;
  if (job.tool === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", CLAUDE_MODE[level]];
    if (job.model) args.push("--model", job.model);
    if (job.resume) args.push("--resume", job.resume);
    return args;
  }
  const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", ...CODEX_SANDBOX[level]];
  if (job.model) args.push("--model", job.model);
  return job.resume ? [...args, "resume", job.resume, "-"] : [...args, "-"];
}

export type RunEvent = { at: number; kind: RunEventKind; text: string };
export type RunReport = { events: RunEvent[]; sessionId?: string; status?: RunStatus; result?: RunResult };

/** Sends a report; answers whether whoever started the session asked to cancel it. */
export type Reporter = (report: RunReport) => Promise<{ cancel: boolean }>;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Stops the CLI and everything it started. `sync` waits for it: the only way while the process is exiting. */
function killTree(child: ChildProcess, sync = false): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    if (sync) {
      try {
        execFileSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
      } catch {
        // gone already
      }
    } else spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // its own process group, spawned detached
  } catch {
    child.kill("SIGTERM");
  }
}

// A remote session must not outlive AI Cooldown: nobody could watch or stop it any more. Once per process, dev reloads included.
const g = globalThis as typeof globalThis & { __aicooldownRuns?: Set<ChildProcess> };
if (!g.__aicooldownRuns) {
  const running = new Set<ChildProcess>();
  g.__aicooldownRuns = running;
  process.once("exit", () => running.forEach((child) => killTree(child, true)));
}
const live = g.__aicooldownRuns;

/** A Codex run's tokens: input includes the cached part. */
type CodexUsage = { input: number; cached: number; output: number };

type Outcome = { ok: boolean; text: string; costUsd?: number; turns?: number; durationMs?: number; usage?: CodexUsage };

const tokens = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/**
 * What a Codex run's tokens would cost at API list prices, as Claude Code
 * reports for its own runs: on the model it asked for, or else the one its
 * thread's log says it ran on.
 */
async function codexCost(job: RunJob, threadId: string | null, since: number, usage: CodexUsage | undefined): Promise<number | undefined> {
  if (!usage || usage.input + usage.output === 0) return undefined;
  const model = job.model ?? (threadId ? await codexModel(threadId, since).catch(() => null) : null);
  if (!model) return undefined;
  const cached = Math.min(usage.cached, usage.input);
  return costOf({ model, input: usage.input - cached, output: usage.output, cacheWrite: 0, cacheWrite1h: 0, cacheRead: cached }) ?? undefined;
}

/** Reads one CLI's stream: what to show, the session id, and how it ended. */
type Stream = { onLine: (msg: Record<string, unknown>) => void; sessionId: () => string | null; outcome: () => Outcome | null };

function claudeStream(job: RunJob, push: (kind: RunEventKind, text: string) => void): Stream {
  let sessionId: string | null = null;
  let outcome: Outcome | null = null;
  return {
    sessionId: () => sessionId,
    outcome: () => outcome,
    onLine(msg) {
      if (typeof msg.session_id === "string") sessionId = msg.session_id;
      const content = (msg.message as { content?: unknown } | undefined)?.content;
      if (msg.type === "system" && msg.subtype === "init") {
        push("info", `Claude Code started · ${msg.model ?? "default model"} · ${msg.permissionMode ?? CLAUDE_MODE[job.mode as Level]} mode`);
      } else if (msg.type === "assistant" && Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "text" && typeof block.text === "string") push("text", block.text);
          else if (block.type === "tool_use") push("tool", describeTool(String(block.name), block.input));
        }
      } else if (msg.type === "user" && Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "tool_result") push(block.is_error ? "error" : "output", clip(outputText(block.content), MAX_OUTPUT));
        }
      } else if (msg.type === "result") {
        const num = (x: unknown) => (typeof x === "number" ? x : undefined);
        const text = typeof msg.result === "string" ? msg.result : "";
        outcome = { ok: msg.is_error !== true && msg.subtype === "success", text, costUsd: num(msg.total_cost_usd), turns: num(msg.num_turns), durationMs: num(msg.duration_ms) };
        push(outcome.ok ? "result" : "error", text || String(msg.subtype ?? "The session ended with an error."));
      }
    },
  };
}

function codexStream(job: RunJob, push: (kind: RunEventKind, text: string) => void): Stream {
  let sessionId: string | null = null;
  let outcome: Outcome | null = null;
  let last = "";
  let turns = 0;
  const usage: CodexUsage = { input: 0, cached: 0, output: 0 };
  const shown = new Set<string>();
  return {
    sessionId: () => sessionId,
    outcome: () => outcome,
    onLine(msg) {
      const item = (msg.item ?? {}) as Record<string, unknown>;
      if (msg.type === "thread.started" && typeof msg.thread_id === "string") {
        sessionId = msg.thread_id;
        push("info", `Codex started · ${job.model ?? "default model"} · ${CODEX_SANDBOX[job.mode as Level].join(" ")}`);
      } else if ((msg.type === "item.started" || msg.type === "item.completed") && item.type === "command_execution") {
        if (!shown.has(String(item.id))) push("tool", `$ ${clip(String(item.command ?? ""), 300)}`);
        shown.add(String(item.id));
        const out = String(item.aggregated_output ?? "");
        if (msg.type === "item.completed" && out.trim()) push(typeof item.exit_code === "number" && item.exit_code !== 0 ? "error" : "output", clip(out, MAX_OUTPUT));
      } else if (msg.type === "item.completed") {
        if (item.type === "agent_message" && typeof item.text === "string") {
          last = item.text;
          push("text", item.text);
        } else if (item.type === "file_change" && Array.isArray(item.changes)) {
          push("tool", clip(`Edit ${(item.changes as { path?: unknown }[]).map((c) => String(c.path)).join(", ")}`, 300));
        } else if (item.type === "mcp_tool_call") {
          push("tool", `${item.server}.${item.tool}`);
        } else if (item.type === "web_search") {
          push("tool", clip(`Web search ${item.query ?? ""}`, 300));
        } else if (item.type === "error" && typeof item.message === "string") {
          push("error", item.message);
        }
      } else if (msg.type === "turn.completed") {
        turns += 1;
        const u = (msg.usage ?? {}) as Record<string, unknown>;
        usage.input += tokens(u.input_tokens);
        usage.cached += tokens(u.cached_input_tokens);
        usage.output += tokens(u.output_tokens);
        outcome = { ok: true, text: last, turns, usage };
      } else if (msg.type === "turn.failed" || msg.type === "error") {
        const error = msg.type === "error" ? msg.message : (msg.error as { message?: unknown } | undefined)?.message;
        outcome = { ok: false, text: typeof error === "string" ? error : "Codex stopped with an error.", turns, usage };
        push("error", outcome.text);
      }
    },
  };
}

/**
 * Runs the session to the end and reports it: events as they come, the final
 * status and result last. `stop` ends it early from this computer, with the
 * reason as its error. Resolves with the final status and the CLI's session id.
 */
export function runSession(job: RunJob, folder: string, report: Reporter, stop: AbortSignal): Promise<{ status: RunStatus; sessionId: string | null }> {
  const { bin, shell } = cliBin(job.tool);
  const started = Date.now();
  // Every argument is fixed or was checked; see cliBin for why a shell and the unquoted name.
  const child = spawn(/* turbopackIgnore: true */ bin, command(job), {
    cwd: folder,
    env: liveEnv(job.tool),
    shell,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  live.add(child);
  child.on("close", () => live.delete(child));

  let pending: RunEvent[] = [];
  let sentSession = false;
  let ended: { status: RunStatus; error: string } | null = null;
  let stderr = "";
  let partial = "";

  const push = (kind: RunEventKind, text: string) => {
    if (text.trim()) pending.push({ at: Date.now(), kind, text: clip(text, MAX_TEXT) });
  };
  const stream = job.tool === "claude" ? claudeStream(job, push) : codexStream(job, push);
  const end = (status: RunStatus, error: string) => {
    ended ??= { status, error };
    killTree(child);
  };
  const onLine = (line: string) => {
    try {
      const msg: unknown = JSON.parse(line);
      if (msg && typeof msg === "object") stream.onLine(msg as Record<string, unknown>);
    } catch {
      // not a stream event: the CLIs' warnings go to stderr anyway
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = partial + chunk.toString();
    const all = text.split("\n");
    partial = all.pop() ?? "";
    for (const line of all) if (line.trim()) onLine(line);
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  child.stdin.on("error", () => undefined); // the CLI may exit before reading it all
  child.stdin.end(job.prompt);

  const onStop = () => end("cancelled", String(stop.reason ?? "Stopped on the computer."));
  stop.addEventListener("abort", onStop);
  if (stop.aborted) onStop(); // stopped between being picked up and starting
  const timeout = setTimeout(() => end("failed", `Stopped after ${TIMEOUT_MS / 60_000} minutes.`), TIMEOUT_MS);

  /** Sends what is pending; a failed send keeps it for the next one. */
  async function flush(final?: { status: RunStatus; result: RunResult }): Promise<void> {
    const batch = pending;
    const id = stream.sessionId();
    const newSession = id && !sentSession ? id : undefined;
    if (!final && batch.length === 0 && !newSession) return;
    pending = [];
    try {
      const { cancel } = await report({ events: batch, sessionId: newSession, ...final });
      if (newSession) sentSession = true;
      if (cancel && !final) end("cancelled", "Cancelled from the dashboard.");
    } catch (err) {
      pending = [...batch, ...pending];
      if (final) throw err;
    }
  }

  return new Promise((resolve) => {
    let flushing = Promise.resolve();
    const ticker = setInterval(() => (flushing = flushing.then(() => flush())), FLUSH_MS);
    let finished = false;
    const finish = async (code: number | null, spawnError?: string) => {
      // A failed start emits both "error" and "close".
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      clearTimeout(timeout);
      stop.removeEventListener("abort", onStop);
      if (partial.trim()) onLine(partial);
      const outcome = stream.outcome();
      const done: { status: RunStatus; error: string } =
        (ended as { status: RunStatus; error: string } | null) ??
        (spawnError
          ? { status: "failed", error: spawnError }
          : outcome?.ok
            ? { status: "done", error: "" }
            : { status: "failed", error: outcome?.text || stderr.trim().split("\n").slice(-3).join(" ") || `The CLI exited with code ${code}.` });
      if (done.status === "done" && job.tool === "codex") push("result", outcome?.text || "Done.");
      if (done.error && done.status !== "done") push(done.status === "cancelled" ? "info" : "error", done.error);
      const costUsd = outcome?.costUsd ?? (job.tool === "codex" ? await codexCost(job, stream.sessionId(), started, outcome?.usage) : undefined);
      const final = {
        status: done.status,
        result: { costUsd, turns: outcome?.turns, durationMs: outcome?.durationMs ?? Date.now() - started, error: done.error || undefined },
      };
      await flushing;
      // The last report carries the outcome: worth a few tries.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await flush(final);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
      resolve({ status: done.status, sessionId: stream.sessionId() });
    };
    const cli = job.tool === "claude" ? "Claude Code" : "Codex";
    child.on("error", (err: NodeJS.ErrnoException) => void finish(null, err.code === "ENOENT" ? `The ${cli} CLI was not found on this computer.` : err.message));
    child.on("close", (code) => void finish(code));
  });
}
