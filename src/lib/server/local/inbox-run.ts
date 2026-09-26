import { open, stat } from "node:fs/promises";
import { costOf } from "@/lib/pricing";
import type { RunJob, RunStatus } from "@/lib/team";
import { claudeText, parse } from "./activity";
import { sendMessage, sentMessage, sessionState, type LiveSession } from "./inbox";
import { outbox, type Reporter } from "./outbox";
import { claudeSteps } from "./transcript";

/*
 * Continuing a Claude Code conversation that is open in a program on this
 * computer (a chat in the Claude app, or a terminal or IDE still in it): the
 * message goes into that session's inbox (see inbox.ts), and what the session
 * does with it comes back from the conversation's own log, read as it is
 * written, until the session is idle again. That program runs the turn on its
 * own login and with its own permissions, which device.ts checks first; this
 * cannot stop the turn there, only stop following it.
 */

/** A conversation open in a program here that takes messages: its session, its log, who the message is from, where it is in words, and a note on how it went in. */
export type OpenChat = { session: LiveSession; log: string; from: string; place: string; note: string };

/** How often the log and the session's state are read. */
const POLL_MS = 1_000;
/** How long a session that is neither busy nor waiting may take to show the message before it counts as not taken: refused, or held without asking. */
const TAKE_MS = 30_000;
/** How long a session may wait for an answer at the computer (whether to take the message, or another question) before the message counts as not taken. */
const ASK_MS = 10 * 60_000;
/** Where the session does not say when it is idle: how long its log stays still after a reply before the turn counts as over. */
const QUIET_MS = 20_000;
/** A turn may run this long before this computer stops following it; it carries on there. */
const TIMEOUT_MS = 30 * 60_000;
/** A log line longer than this is skipped rather than read. */
const MAX_LINE = 16 * 1024 * 1024;

type Ended = { status: RunStatus; error: string };

const tokens = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/** Sleeps, waking early when the run is stopped. */
function delay(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener("abort", done, { once: true });
  });
}

/** The complete lines written to `file` after byte `offset`, and where the next read starts. */
async function linesAfter(file: string, offset: number): Promise<{ lines: string[]; next: number }> {
  const handle = await open(/* turbopackIgnore: true */ file, "r");
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], next: Math.min(offset, size) };
    const length = Math.min(size - offset, MAX_LINE);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    // No line ends in a whole read: a line too long to follow, skipped.
    if (end < 0) return { lines: [], next: bytesRead === MAX_LINE ? offset + bytesRead : offset };
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), next: offset + end + 1 };
  } finally {
    await handle.close();
  }
}

/** What a reply in the log cost at API list prices, once per reply (`billed` has those counted); null for anything else. */
function replyCost(entry: Record<string, unknown>, billed: Set<string>): number | null {
  const message = entry.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
  const u = message?.usage;
  if (entry.type !== "assistant" || !u || typeof message.model !== "string" || message.model === "<synthetic>") return null;
  const key = `${message.id}:${entry.requestId}`;
  if (billed.has(key)) return null;
  billed.add(key);
  const cacheWrite = tokens(u.cache_creation_input_tokens);
  const hour = tokens((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
  return costOf({ model: message.model, input: tokens(u.input_tokens), output: tokens(u.output_tokens), cacheWrite, cacheWrite1h: Math.min(hour, cacheWrite), cacheRead: tokens(u.cache_read_input_tokens) });
}

/**
 * Sends the message into the conversation open in `chat` and reports what its
 * session does with it: events as they are written, and the outcome. Resolves
 * with the final status.
 */
export async function runInbox(job: RunJob, chat: OpenChat, report: Reporter, stop: AbortSignal): Promise<RunStatus> {
  const started = Date.now();
  let ended = null as Ended | null;
  const end = (status: RunStatus, error = "") => {
    ended ??= { status, error };
  };
  const out = outbox(report, () => chat.session.sessionId, () => end("cancelled", `Stopped following it from the dashboard: it goes on in ${chat.place} on the computer.`));
  const onStop = () => end("cancelled", String(stop.reason ?? "Stopped on the computer."));
  stop.addEventListener("abort", onStop);

  const snippet = job.prompt.trim().slice(0, 200);
  const ours = (text: string) => sentMessage(text) !== null || (snippet.length >= 4 && text.includes(snippet));
  const blocks = new Set<string>();
  const billed = new Set<string>();
  let costUsd: number | undefined;
  let offset = 0;
  /** Whether what the log gets is passed on: from the message on, or all of it when the session was idle before, as then all of it is the message's. */
  let passing = false;
  /** When the session took the message, as the log or its state shows; null until then. */
  let taken: number | null = null;
  /** Whether anything came of it: a reply, a tool, a note. */
  let progressed = false;
  let worked = false;
  let waiting = false;
  let last = "";
  let grew = Date.now();
  let sent = Date.now();

  const read = async () => {
    const { lines, next } = await linesAfter(chat.log, offset);
    if (next !== offset) grew = Date.now();
    offset = next;
    for (const line of lines) {
      const entry = parse(line);
      if (!entry || entry.isSidechain) continue;
      if (entry.type === "user" && ours(claudeText(entry))) {
        taken ??= Date.parse(String(entry.timestamp)) || Date.now();
        passing = true;
        continue;
      }
      if (!passing) continue;
      claudeSteps(entry, blocks, (_at, kind, text) => {
        if (kind === "image") return; // the conversation shows images
        progressed = true;
        if (kind === "user") out.push("info", `Said in ${chat.place}: ${text}`);
        else out.push(kind, text);
        if (kind === "text") last = text;
      });
      const cost = replyCost(entry, billed);
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
    }
    // Something came while all of it is the message's: it has been taken.
    if (progressed) taken ??= sent;
  };

  try {
    offset = (await stat(chat.log)).size;
    passing = (await sessionState(chat.session))?.status === "idle";
    await sendMessage(chat.session, job.prompt, chat.from);
    sent = Date.now();
    out.push("info", chat.note);
  } catch (err) {
    end("failed", `Could not send it into ${chat.place}: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (stop.aborted) onStop();

  while (!ended) {
    await delay(POLL_MS, stop);
    if (ended) continue;
    await read().catch(() => undefined);
    const state = await sessionState(chat.session);
    const now = Date.now();
    if (!state || state.sessionId !== chat.session.sessionId) {
      if (taken !== null && progressed) end("done");
      else end("failed", `It was closed in ${chat.place} before it ${taken === null ? "took the message" : "finished"}.`);
      continue;
    }
    if (state.status === "waiting" && !waiting) out.push("info", `Waiting for an answer in ${chat.place} on the computer${state.waitingFor ? ` (${state.waitingFor})` : ""}.`);
    waiting = state.status === "waiting";
    if (taken === null) {
      // Idle when it was before: started on the message.
      if (passing && state.status === "busy") taken = sent;
      else if (waiting ? now - sent > ASK_MS : state.status !== "busy" && now - sent > TAKE_MS) {
        end(
          "failed",
          waiting
            ? `It is still waiting for an answer in ${chat.place} on the computer and has not taken the message. It goes in once that is answered there; read the conversation again to see the reply.`
            : `It did not take the message: ${chat.place} may hold messages from other programs for approval without asking, or refuse them (its "Messages from your other sessions" setting). Continue it there, or close it there and send again.`,
        );
        continue;
      }
    } else if (state.status === "idle") {
      // Over once it went back to idle after working on it; a turn done between two reads shows as idle since after the message.
      if (worked || (progressed && state.since !== null && state.since > taken)) {
        await read().catch(() => undefined);
        end("done");
        continue;
      }
    } else if (state.status === null) {
      if (progressed && last && now - grew > QUIET_MS) end("done");
    } else worked = true;
    if (now - started > TIMEOUT_MS) end("failed", `Stopped following it after ${TIMEOUT_MS / 60_000} minutes: it goes on in ${chat.place} on the computer.`);
  }
  stop.removeEventListener("abort", onStop);
  const done = ended as Ended;
  if (done.status === "done") out.push("result", last || "Done.");
  else out.push(done.status === "cancelled" ? "info" : "error", done.error);
  await out.close({ status: done.status, result: { costUsd, durationMs: Date.now() - started, error: done.error || undefined } });
  return done.status;
}
