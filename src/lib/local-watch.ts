import { useSyncExternalStore } from "react";
import { fetchLocalState, type LocalState } from "./local";
import { notifyIfEnabled } from "./notify";
import { TOOL_NAME } from "./team";

/*
 * "This machine" as the local server reports it, read by one poller for
 * everyone who watches: LocalPanel on the dashboard, and in the desktop app the
 * shell on every page, so a remote session someone else starts here is
 * announced whichever page is showing.
 */

const REFRESH_MS = 30_000;

/** undefined until the first answer, null when this copy does not run on the user's computer. */
let state: LocalState | null | undefined;
/** When `state` was read. */
let readAt = 0;
const listeners = new Set<() => void>();
/** Remote sessions already seen, so each new one someone else starts here is announced once. */
let seen: Set<string> | null = null;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

/** Shows a fresh answer (a poll's, or an action's) and announces new remote sessions. */
export function showLocalState(next: LocalState): void {
  if (seen) {
    for (const r of next.device.recent) {
      if (seen.has(r.id) || r.by === next.device.owner?.email) continue;
      notifyIfEnabled(`A remote ${TOOL_NAME[r.tool]} session started on this computer`, `${r.by ?? "Someone"}: ${r.prompt.slice(0, 140)}`, `run:${r.id}`);
    }
  }
  seen = new Set(next.device.recent.map((r) => r.id));
  state = next;
  readAt = Date.now();
  emit();
}

/** Reads it again; returns whether it could. A failed read keeps what is on screen. */
export async function reloadLocalState(): Promise<boolean> {
  const next = await fetchLocalState();
  if (next) showLocalState(next);
  else if (state === undefined) {
    state = null;
    emit();
  }
  return next !== null;
}

/** When what useLocalState gives was read: it changes with every read, so this is current wherever that is used. */
export const localStateReadAt = () => readAt;

/** Keeps it fresh while anyone watches; nothing is polled where there is no local server (the website). */
export function watchLocalState(): () => void {
  if (watchers++ === 0) {
    void reloadLocalState().then(() => {
      if (state && watchers > 0) timer ??= setInterval(() => void reloadLocalState(), REFRESH_MS);
    });
  }
  return () => {
    if (--watchers > 0) return;
    if (timer) clearInterval(timer);
    timer = null;
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocalState(): LocalState | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => undefined,
  );
}
