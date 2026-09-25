import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceActivity, Tool } from "@/lib/activity";
import type { LocalDevice, LocalRun } from "@/lib/local";
import { accountsTarget } from "@/lib/server/accounts-server";
import { SESSION_COOKIE } from "@/lib/server/cookies";
import { DATA_DIR } from "@/lib/server/data-dir";
import { levelAllows, MAX_PROMPT, MODEL_NAME, REMOTE_LABEL, REMOTE_LEVELS, SESSION_ID, type DeviceInfo, type RemoteLevel, type RunJob, type RunStatus } from "@/lib/team";
import type { Provider } from "@/lib/types";
import pkg from "../../../../package.json";
import { scanActivity, type Scan } from "./activity";
import { liveState } from "./cli";
import { runSession, type RunReport } from "./runner";
import { readTranscript, type TranscriptEvent } from "./transcript";

/*
 * This computer as a device of the AI Cooldown account signed in here, once
 * its user connects it. It checks in with the server that keeps the account
 * (aicooldown.com for the desktop app, or this copy itself): what it is, which
 * accounts its CLIs are signed in with, every Claude Code and Codex session it
 * ran, and what its user allows here. Two settings are this computer's alone,
 * and it holds the server to them rather than taking it at its word: what
 * remote sessions may do (it runs the ones it is sent, one at a time), and
 * whether what sessions say (titles, and transcripts on request) leaves it.
 * data/device.json keeps its token, those settings, and a note of the remote
 * sessions it ran.
 */

const FILE = path.join(DATA_DIR, "device.json");
/** Check-ins: often enough to answer quickly while remote sessions or transcripts are allowed, once a minute otherwise. */
const SYNC_MS = { quick: 15_000, slow: 60_000 };
/** How often the session logs are read again; the report goes out when it changed. */
const SCAN_MS = 2 * 60_000;
const TIMEOUT_MS = 20_000;
const KEEP_RUNS = 20;

type Link = { server: string; deviceId: string; token: string; userId: string; email: string };
type Stored = { machineId: string; remote: RemoteLevel; share: boolean; owner: LocalDevice["owner"]; link: Link | null; runs: LocalRun[] };
type TranscriptAsk = { tool: Tool; sessionId: string };

type Runtime = {
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  syncing: boolean;
  again: boolean;
  lastSync: number | null;
  error: string | null;
  /** The latest read of the session logs. */
  scan: (Scan & { at: number }) | null;
  /** The activity report the server has last been sent, as sent. */
  reported: string | null;
  running: { run: LocalRun; stop: AbortController } | null;
  queue: Promise<unknown>;
};

// Survives dev-server module reloads, so it never checks in twice over.
const g = globalThis as typeof globalThis & { __aicooldownDevice?: Runtime };
const runtime = (g.__aicooldownDevice ??= {
  started: false,
  timer: undefined,
  syncing: false,
  again: false,
  lastSync: null,
  error: null,
  scan: null,
  reported: null,
  running: null,
  queue: Promise.resolve(),
});

const reason = (err: unknown) => {
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return cause ?? (err instanceof Error ? err.message : String(err));
};

async function load(): Promise<Stored> {
  try {
    const s = JSON.parse(await readFile(FILE, "utf8")) as Partial<Stored>;
    if (typeof s.machineId === "string") {
      return {
        machineId: s.machineId,
        remote: REMOTE_LEVELS.includes(s.remote as RemoteLevel) ? (s.remote as RemoteLevel) : "off",
        share: s.share === true,
        owner: s.owner ?? null,
        link: s.link ?? null,
        // Runs noted before Codex could run here were Claude Code's.
        runs: (s.runs ?? []).map((r) => ({ ...r, tool: r.tool === "codex" ? "codex" : "claude" })),
      };
    }
  } catch {
    /* not connected yet */
  }
  return { machineId: randomUUID(), remote: "off", share: false, owner: null, link: null, runs: [] };
}

/** One change at a time, written whole and readable by this user only: it holds the computer's token. */
function update(fn: (s: Stored) => void): Promise<Stored> {
  const next = runtime.queue
    .catch(() => undefined)
    .then(async () => {
      const s = await load();
      fn(s);
      await mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      await rename(tmp, FILE);
      return s;
    });
  runtime.queue = next;
  return next;
}

function osName(): string {
  if (process.platform === "win32") return os.version();
  if (process.platform === "darwin") return `macOS (Darwin ${os.release()})`;
  return `${os.type()} ${os.release()}`;
}

async function deviceInfo(stored: Stored): Promise<DeviceInfo> {
  const live = await liveState()
    .then((s) => s.live)
    .catch(() => null);
  const login = (provider: Provider) => {
    const l = live?.[provider];
    return l && "label" in l ? l.label : null;
  };
  return {
    name: os.hostname(),
    os: osName(),
    platform: process.platform,
    arch: process.arch,
    version: pkg.version,
    logins: { claude: login("claude"), codex: login("codex") },
    remote: stored.remote,
    share: stored.share,
  };
}

/** The activity report as it leaves this computer: without session titles unless it shares session content. */
function report(activity: DeviceActivity, share: boolean): DeviceActivity {
  return share ? activity : { ...activity, sessions: activity.sessions.map((s) => ({ ...s, title: null })) };
}

function agentFetch(link: Link, route: string, method: string, body?: unknown): Promise<Response> {
  return fetch(link.server + route, {
    method,
    headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function schedule(ms: number): void {
  clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => void tick(), ms);
}

/** Checks in right away, or right after the check-in under way. */
function soon(): void {
  if (runtime.syncing) runtime.again = true;
  else schedule(0);
}

async function tick(): Promise<void> {
  runtime.syncing = true;
  try {
    await sync();
  } catch (err) {
    runtime.error = `Could not check in: ${reason(err)}`;
  } finally {
    runtime.syncing = false;
  }
  const s = await load();
  if (!s.link) return; // idle until it is connected again
  schedule(runtime.again ? 0 : s.remote !== "off" || s.share ? SYNC_MS.quick : SYNC_MS.slow);
  runtime.again = false;
}

/** Idempotent; at server start and with every request to the local API. */
export function startAgent(): void {
  if (runtime.started) return;
  runtime.started = true;
  schedule(0);
}

async function sync(): Promise<void> {
  const stored = await load();
  const link = stored.link;
  if (!link) return;
  if (!runtime.scan || Date.now() - runtime.scan.at > SCAN_MS) {
    // A failed read keeps the last one: checking in matters more than the report.
    const fresh = await scanActivity().catch(() => null);
    if (fresh) runtime.scan = { ...fresh, at: fresh.activity.scannedAt };
  }
  const activity = runtime.scan ? report(runtime.scan.activity, stored.share) : null;
  const outgoing = activity && JSON.stringify(activity);
  const sending = outgoing !== null && outgoing !== runtime.reported;
  const res = await agentFetch(link, "/api/agent", "POST", { info: await deviceInfo(stored), activity: sending ? activity : undefined, busy: runtime.running !== null });
  if (res.status === 401) {
    // Signed out everywhere, or removed from the dashboard. It reconnects with a new token when its owner signs in here again.
    await update((s) => {
      if (s.link?.token === link.token) s.link = null;
    });
    runtime.error = "The account disconnected this computer. It connects again when you sign in here.";
    return;
  }
  const json = (await res.json().catch(() => ({}))) as { run?: RunJob | null; transcripts?: TranscriptAsk[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `${new URL(link.server).host} answered ${res.status}`);
  runtime.lastSync = Date.now();
  runtime.error = null;
  if (sending) runtime.reported = outgoing;
  if (json.run) {
    // Handed a session while running one (two check-ins crossed): say so rather than leave it hanging.
    if (runtime.running) {
      const busy = "This computer was running another session; start it again.";
      void agentFetch(link, `/api/agent/runs/${encodeURIComponent(json.run.id)}`, "POST", { events: [], status: "failed", result: { error: busy } }).catch(() => undefined);
    } else void execute(json.run, link);
  }
  for (const ask of (json.transcripts ?? []).slice(0, 3)) await answerTranscript(link, ask, stored.share);
}

/**
 * Reads a session's transcript for the dashboard and sends it, if this
 * computer shares session content. Only a session from this computer's own
 * scan: the server names it, the scan says which file it is.
 */
async function answerTranscript(link: Link, ask: TranscriptAsk, share: boolean): Promise<void> {
  const file = typeof ask.sessionId === "string" && SESSION_ID.test(ask.sessionId) ? runtime.scan?.logs.get(`${ask.tool}:${ask.sessionId}`) : undefined;
  let answer: { events?: TranscriptEvent[]; error?: string };
  if (!share) answer = { error: "This computer does not share session content." };
  else if ((ask.tool !== "claude" && ask.tool !== "codex") || !file) answer = { error: "That session is not on this computer, or is more than 30 days old." };
  else answer = await readTranscript(ask.tool, file).then((events) => ({ events }), (err: unknown) => ({ error: `Could not read the session's log: ${reason(err)}` }));
  await agentFetch(link, "/api/agent/transcripts", "POST", { tool: ask.tool, sessionId: ask.sessionId, ...answer }).catch(() => undefined);
}

/** Connects this computer to the account the request is signed in with, where that account is kept. */
export async function connect(req: Request): Promise<void> {
  const { origin, session } = accountsTarget(req);
  if (!session) throw new Error("Sign in first, then connect this computer.");
  const stored = await update(() => undefined); // keeps a first run's machine id
  let res: Response;
  try {
    res = await fetch(`${origin}/api/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` },
      body: JSON.stringify({ machineId: stored.machineId, info: await deviceInfo(stored) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach ${new URL(origin).host} (${reason(err)}).`);
  }
  const json = (await res.json().catch(() => ({}))) as { device?: { id: string }; token?: string; user?: { id: string; email: string }; error?: string };
  if (!res.ok || !json.device || !json.token || !json.user) throw new Error(json.error ?? `${new URL(origin).host} answered ${res.status}.`);
  const link: Link = { server: origin, deviceId: json.device.id, token: json.token, userId: json.user.id, email: json.user.email };
  await update((s) => {
    s.link = link;
    s.owner = { userId: link.userId, email: link.email };
  });
  runtime.error = null;
  runtime.reported = null; // send the activity report on the first check-in
  soon();
}

/** Disconnects it. `forget` also forgets whose it was, so it stays disconnected when they sign in again. */
export async function disconnect(forget: boolean): Promise<void> {
  const { link } = await load();
  runtime.running?.stop.abort("This computer was disconnected.");
  if (link) await agentFetch(link, "/api/agent", "DELETE").catch(() => undefined);
  await update((s) => {
    s.link = null;
    if (forget) s.owner = null;
  });
  runtime.error = null;
}

/** What remote sessions may do here. Lowering it stops a session that asked for more. */
export async function setRemote(level: RemoteLevel): Promise<void> {
  await update((s) => {
    s.remote = level;
  });
  const running = runtime.running;
  if (running && !levelAllows(level, running.run.mode)) running.stop.abort("Stopped: remote sessions were limited on this computer while it ran.");
  soon();
}

/** Whether what sessions say leaves this computer. Turning it off also has the server drop the transcripts it keeps from here. */
export async function setShare(on: boolean): Promise<void> {
  await update((s) => {
    s.share = on;
  });
  soon();
}

/** Stops the remote session running here, from this computer. */
export function stopRun(): void {
  runtime.running?.stop.abort("Stopped on the computer it ran on.");
}

export async function deviceState(): Promise<LocalDevice> {
  const s = await load();
  return {
    linked: s.link ? { server: new URL(s.link.server).host, email: s.link.email } : null,
    owner: s.owner,
    remote: s.remote,
    share: s.share,
    lastSync: runtime.lastSync,
    error: runtime.error,
    running: runtime.running?.run ?? null,
    recent: s.runs,
  };
}

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** Why this computer will not run the session, or null when it will. */
function refusal(job: RunJob, stored: Stored): string | null {
  if (!levelAllows(stored.remote, job.mode)) return stored.remote === "off" ? "Remote sessions are off on this computer." : `This computer allows sessions up to "${REMOTE_LABEL[stored.remote]}".`;
  if (job.tool !== "claude" && job.tool !== "codex") return "Unknown CLI.";
  if (typeof job.prompt !== "string" || !job.prompt.trim() || job.prompt.length > MAX_PROMPT) return "The prompt is empty or too long.";
  if (job.model !== null && (typeof job.model !== "string" || !MODEL_NAME.test(job.model))) return "Unknown model.";
  const folder = typeof job.project === "string" ? runtime.scan?.folders.get(job.project) : undefined;
  if (!folder || !isDirectory(folder)) return "That project is not on this computer (any more).";
  // Only a conversation a remote session started here, never one of this computer's own.
  if (job.resume !== null && !(typeof job.resume === "string" && SESSION_ID.test(job.resume) && stored.runs.some((r) => r.sessionId === job.resume && r.project === job.project && r.tool === job.tool))) {
    return "Only a session started from the dashboard can be continued.";
  }
  return null;
}

async function execute(job: RunJob, link: Link): Promise<void> {
  const stop = new AbortController();
  const run: LocalRun = { id: job.id, tool: job.tool, project: job.project, prompt: String(job.prompt).slice(0, 300), by: job.by, mode: job.mode, status: "running", at: Date.now(), sessionId: job.resume };
  // Set before anything is awaited: the next check-in must say it is busy.
  runtime.running = { run, stop };
  const send = async (r: RunReport) => {
    const res = await agentFetch(link, `/api/agent/runs/${encodeURIComponent(job.id)}`, "POST", r);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { cancel: boolean };
  };
  let status: RunStatus = "failed";
  try {
    const refused = refusal(job, await load());
    await update((s) => {
      s.runs = [run, ...s.runs.filter((r) => r.id !== run.id)].slice(0, KEEP_RUNS);
    });
    if (refused) {
      await send({ events: [{ at: Date.now(), kind: "error", text: refused }], status: "failed", result: { error: refused } }).catch(() => undefined);
    } else {
      const out = await runSession(job, runtime.scan!.folders.get(job.project)!, send, stop.signal);
      status = out.status;
      run.sessionId = out.sessionId ?? run.sessionId;
    }
  } catch (err) {
    await send({ events: [], status: "failed", result: { error: reason(err) } }).catch(() => undefined);
  } finally {
    runtime.running = null;
    await update((s) => {
      s.runs = s.runs.map((r) => (r.id === run.id ? { ...run, status } : r));
    }).catch(() => undefined);
    soon();
  }
}
