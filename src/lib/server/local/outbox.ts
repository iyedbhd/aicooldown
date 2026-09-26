import type { RunEventKind, RunResult, RunStatus } from "@/lib/team";

/*
 * A remote session's output on its way to whoever started it, however it runs
 * (the CLI in runner.ts, or a conversation open in a program in inbox-run.ts):
 * events as they come, sent every FLUSH_MS with the session id once it is
 * known; with nothing to send, a word now and then to hear whether they asked
 * to cancel it; and the outcome last, tried a few times.
 */

export type RunEvent = { at: number; kind: RunEventKind; text: string };
export type RunReport = { events: RunEvent[]; sessionId?: string; status?: RunStatus; result?: RunResult };

/** Sends a report; answers whether whoever started the session asked to cancel it. */
export type Reporter = (report: RunReport) => Promise<{ cancel: boolean }>;

export type RunEnd = { status: RunStatus; result: RunResult };

/** How often output is sent while it runs. */
const FLUSH_MS = 1_500;
/** With nothing to send, how often it still asks whether to cancel: Stop works while a session writes nothing. */
const ASK_MS = 5_000;
const MAX_TEXT = 4_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The run's outbox: `push` its events, then `close` with its outcome. `onCancel` runs when whoever started it asks to cancel. */
export function outbox(report: Reporter, sessionId: () => string | null, onCancel: () => void) {
  let pending: RunEvent[] = [];
  let sentSession = false;
  let lastSent = Date.now();
  const push = (kind: RunEventKind, text: string) => {
    if (text.trim()) pending.push({ at: Date.now(), kind, text: clip(text, MAX_TEXT) });
  };
  /** Sends what is pending; a failed send keeps it for the next one. */
  async function flush(final?: RunEnd): Promise<void> {
    const batch = pending;
    const id = sessionId();
    const newSession = id && !sentSession ? id : undefined;
    if (!final && batch.length === 0 && !newSession && Date.now() - lastSent < ASK_MS) return;
    pending = [];
    try {
      const { cancel } = await report({ events: batch, sessionId: newSession, ...final });
      lastSent = Date.now();
      if (newSession) sentSession = true;
      if (cancel && !final) onCancel();
    } catch (err) {
      pending = [...batch, ...pending];
      if (final) throw err;
    }
  }
  let flushing = Promise.resolve();
  const ticker = setInterval(() => (flushing = flushing.then(() => flush())), FLUSH_MS);
  /** Sends the outcome after what is pending; nothing goes after it. The last report carries the outcome: worth a few tries. */
  async function close(final: RunEnd): Promise<void> {
    clearInterval(ticker);
    await flushing;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await flush(final);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  }
  return { push, close };
}
