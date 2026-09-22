import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HelloRun, HelloSchedule, LocalState, ScheduleMode } from "@/lib/local";
import type { Provider } from "@/lib/types";
import { forget, liveState, saveCurrent, sayHello, sessionResetAt, switchTo } from "./cli";

/**
 * Scheduled hellos, kept in data/local-schedules.json and armed as timers in
 * this server process. One missed while the server was down fires as soon as
 * it starts again.
 */

const FILE = path.join(process.cwd(), "data", "local-schedules.json");
/** Fire a little after the reset so the new window is the one the hello opens. */
const AFTER_RESET_MS = 60_000;
const SESSION_MS = 5 * 3600_000;
/** setTimeout overflows past ~24.8 days; longer waits re-arm on wake. */
const MAX_DELAY_MS = 2 ** 31 - 1;

type Store = { schedules: HelloSchedule[]; runs: Record<string, HelloRun> };

// Survives dev-server module reloads, so timers are never armed twice.
const g = globalThis as typeof globalThis & {
  __aicooldownLocal?: { timers: Map<string, NodeJS.Timeout>; started: boolean; queue: Map<string, Promise<unknown>> };
};
const runtime = (g.__aicooldownLocal ??= { timers: new Map(), started: false, queue: new Map() });

/**
 * Runs one CLI operation at a time per provider (and one store update at a
 * time): switching and a hello on the live login touch the same files.
 */
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = runtime.queue.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  runtime.queue.set(key, next);
  return next;
}

async function load(): Promise<Store> {
  try {
    const json = JSON.parse(await readFile(FILE, "utf8")) as Partial<Store>;
    return { schedules: json.schedules ?? [], runs: json.runs ?? {} };
  } catch {
    return { schedules: [], runs: {} };
  }
}

async function save(store: Store): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2));
  await rename(tmp, FILE);
}

function update(fn: (store: Store) => void): Promise<Store> {
  return serialize("store", async () => {
    const store = await load();
    fn(store);
    await save(store);
    return store;
  });
}

function arm(s: HelloSchedule): void {
  clearTimeout(runtime.timers.get(s.id));
  const delay = Math.max(0, s.at - Date.now());
  const timer = setTimeout(() => void (delay > MAX_DELAY_MS ? arm(s) : fire(s.id)), Math.min(delay, MAX_DELAY_MS));
  runtime.timers.set(s.id, timer);
}

/** Idempotent; called at server start and before any local request. */
export async function startScheduler(): Promise<void> {
  if (runtime.started) return;
  runtime.started = true;
  for (const s of (await load()).schedules) arm(s);
}

async function providerOf(profileId: string): Promise<Provider> {
  const profile = (await liveState()).profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("That saved login no longer exists.");
  return profile.provider;
}

async function hello(profileId: string, scheduled: boolean): Promise<HelloRun> {
  const provider = await providerOf(profileId);
  const run = await serialize(provider, () => sayHello(profileId))
    .then((message): HelloRun => ({ at: Date.now(), ok: true, message, scheduled }))
    .catch((err: unknown): HelloRun => ({ at: Date.now(), ok: false, message: err instanceof Error ? err.message : String(err), scheduled }));
  await update((store) => {
    store.runs[profileId] = run;
  });
  return run;
}

async function fire(id: string): Promise<void> {
  runtime.timers.delete(id);
  const s = (await load()).schedules.find((x) => x.id === id);
  if (!s) return;
  const run = await hello(s.profileId, true).catch((): HelloRun => ({ at: Date.now(), ok: false, message: "", scheduled: true }));
  let next: number | null = null;
  if (s.mode === "every-reset") {
    // The hello just opened a window; its reset is the next send. If it failed, try again in a while.
    const reset = run.ok ? await sessionResetAt(s.profileId).catch(() => null) : null;
    next = (reset ?? run.at + (run.ok ? SESSION_MS : 15 * 60_000)) + (run.ok ? AFTER_RESET_MS : 0);
  }
  const store = await update((st) => {
    st.schedules = next === null ? st.schedules.filter((x) => x.id !== id) : st.schedules.map((x) => (x.id === id ? { ...x, at: next! } : x));
  });
  const updated = store.schedules.find((x) => x.id === id);
  if (updated) arm(updated);
}

async function addSchedule(profileId: string, mode: ScheduleMode, at?: number): Promise<void> {
  let when: number;
  if (mode === "at") {
    if (typeof at !== "number" || !Number.isFinite(at) || at < Date.now() - 60_000) throw new Error("Pick a time in the future.");
    when = at;
  } else {
    const reset = await sessionResetAt(profileId).catch((err: unknown) => {
      throw new Error(`Could not read this login's reset time: ${err instanceof Error ? err.message : String(err)}. Pick a time instead.`);
    });
    // No window running: the next "reset" is now, so the hello starts one.
    when = reset === null ? Date.now() : reset + AFTER_RESET_MS;
  }
  const s: HelloSchedule = { id: randomUUID(), profileId, mode, at: when, createdAt: Date.now() };
  await update((store) => store.schedules.push(s));
  arm(s);
}

async function cancelWhere(match: (s: HelloSchedule) => boolean): Promise<void> {
  await update((store) => {
    for (const s of store.schedules.filter(match)) clearTimeout(runtime.timers.get(s.id));
    store.schedules = store.schedules.filter((s) => !match(s));
  });
}

export async function localState(): Promise<LocalState> {
  const [{ live, profiles }, store] = await Promise.all([liveState(), load()]);
  return { live, profiles, schedules: store.schedules, runs: store.runs };
}

/** The route's actions, validated there. */
export const actions = {
  save: (provider: Provider) => serialize(provider, () => saveCurrent(provider)),
  switch: async (profileId: string) => {
    const provider = await providerOf(profileId);
    await serialize(provider, () => switchTo(profileId));
  },
  forget: async (profileId: string) => {
    const provider = await providerOf(profileId);
    await cancelWhere((s) => s.profileId === profileId);
    await serialize(provider, () => forget(profileId));
    await update((store) => delete store.runs[profileId]);
  },
  hello: async (profileId: string) => {
    const run = await hello(profileId, false);
    if (!run.ok) throw new Error(run.message);
  },
  schedule: addSchedule,
  cancel: (scheduleId: string) => cancelWhere((s) => s.id === scheduleId),
};
