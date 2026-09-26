import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceActivity, Tool } from "@/lib/activity";
import type { LocalDevice, LocalRun, ScheduleMode } from "@/lib/local";
import { accountsTarget } from "@/lib/server/accounts-server";
import { SESSION_COOKIE } from "@/lib/server/cookies";
import { DATA_DIR } from "@/lib/server/data-dir";
import {
  levelAllows,
  MAX_IMAGE_BYTES,
  MAX_PROMPT,
  MODEL_NAME,
  projectName,
  REMOTE_LABEL,
  REMOTE_LEVELS,
  SESSION_ID,
  TOOL_NAME,
  type CommandKind,
  type DeviceInfo,
  type DeviceManage,
  type DeviceSharing,
  type RemoteLevel,
  type RunJob,
  type RunStatus,
  type ShareLevel,
  type ToolState,
} from "@/lib/team";
import { openIn } from "@/lib/team-stats";
import type { Provider } from "@/lib/types";
import pkg from "../../../../package.json";
import { scanActivity, type Scan } from "./activity";
import { appChatMode } from "./claude-app";
import { conversationOpen, liveState, readLoginPath, toolState } from "./cli";
import { FROM, liveSession, liveSessions, type LiveSession } from "./inbox";
import { runInbox, type OpenChat } from "./inbox-run";
import type { RunReport } from "./outbox";
import { runSession } from "./runner";
import { decodedBytes, readImages, readTranscript, type LoggedImage, type TranscriptEvent } from "./transcript";

/*
 * This computer as a device of the AI Cooldown account signed in here, once
 * its user connects it. It checks in with the server that keeps the account
 * (aicooldown.com for the desktop app, or this copy itself): what it is, which
 * accounts its CLIs are signed in with and whether they can run, every Claude
 * Code and Codex session it ran, and for its owner the logins it keeps and the
 * hellos it has scheduled. Two settings are this computer's, and it holds the
 * server to them rather than taking it at its word: what remote sessions may
 * do (it runs the ones it is sent, one at a time), and whether what sessions
 * say (titles, and transcripts on request) reaches the website, which a team
 * member's computer always lets it: their teams' owners and admins see all of
 * their work. The server says at each check-in what else its owner shares,
 * and it runs sessions for others only in that. Its owner can also have it
 * switch or save a CLI login and say hello from the website. data/device.json
 * keeps its token, those settings, and a note of the remote sessions it ran.
 */

const FILE = path.join(DATA_DIR, "device.json");
/** Check-ins: often enough to answer quickly while remote sessions or transcripts are allowed, once a minute otherwise. */
const SYNC_MS = { quick: 15_000, slow: 60_000 };
/** How often the session logs are read again; the report goes out when it changed. */
const SCAN_MS = 2 * 60_000;
/** What a check-in says about the CLIs and saved logins is read again after this long, or after a change here. */
const CLIS_MS = 10_000;
const TIMEOUT_MS = 20_000;
/** An image is up to a couple of megabytes: sending one may take longer on a slow line. */
const IMAGE_TIMEOUT_MS = 90_000;
const KEEP_RUNS = 20;

type Link = { server: string; deviceId: string; token: string; userId: string; email: string };
type Stored = {
  machineId: string;
  remote: RemoteLevel;
  /** Its owner's choice; what it does is effectiveShare's. */
  share: ShareLevel;
  /** What the server said at the latest check-in about who else sees what of it. */
  sharing: DeviceSharing | null;
  owner: LocalDevice["owner"];
  link: Link | null;
  runs: LocalRun[];
};
type TranscriptAsk = { tool: Tool; sessionId: string };
type ImageAsk = { tool: Tool; sessionId: string; n: number };
type CommandJob = { id: string; kind: CommandKind; args: Record<string, unknown>; by: string | null };
type Clis = { logins: DeviceInfo["logins"]; tools: Record<Tool, ToolState>; manage: DeviceManage };

type Runtime = {
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  syncing: boolean;
  again: boolean;
  lastSync: number | null;
  error: string | null;
  /** The latest read of the session logs. */
  scan: (Scan & { at: number }) | null;
  /** The read under way, if one is: check-ins do not wait for it, but for the first. */
  scanning: Promise<void> | null;
  /** The activity report the server has last been sent, as sent. */
  reported: string | null;
  running: { run: LocalRun; stop: AbortController } | null;
  queue: Promise<unknown>;
  /** The latest read of the CLIs and saved logins. */
  clis: { at: number; value: Clis } | null;
  /** How soon the server asked to hear again: sooner while someone works with this computer from the website. */
  pollMs: number | undefined;
  /** Commands from the owner, one at a time. */
  commands: Promise<unknown>;
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
  scanning: null,
  reported: null,
  running: null,
  queue: Promise.resolve(),
  clis: null,
  pollMs: undefined,
  commands: Promise.resolve(),
});

const reason = (err: unknown) => {
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return cause ?? (err instanceof Error ? err.message : String(err));
};

/** Before 0.7 on was "me" or "team", and before 0.6 true. */
const shareOf = (v: unknown): ShareLevel => (v === "on" || v === "me" || v === "team" || v === true ? "on" : "off");

function sharingOf(raw: unknown): DeviceSharing | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const list = (x: unknown, max: number) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length <= 200).slice(0, max) : []);
  return { managedBy: list(v.managedBy, 50), all: v.all === true, projects: list(v.projects, 500), sessions: list(v.sessions, 2_000) };
}

/** A team member's computer lets what sessions say reach the website, whatever its owner chose: their teams' owners and admins see all of their work. */
const effectiveShare = (s: Stored): ShareLevel => (s.sharing?.managedBy.length ? "on" : s.share);

async function load(): Promise<Stored> {
  try {
    const s = JSON.parse(await readFile(FILE, "utf8")) as Partial<Stored> & { share?: unknown };
    if (typeof s.machineId === "string") {
      return {
        machineId: s.machineId,
        remote: REMOTE_LEVELS.includes(s.remote as RemoteLevel) ? (s.remote as RemoteLevel) : "off",
        share: shareOf(s.share),
        sharing: sharingOf(s.sharing),
        owner: s.owner ?? null,
        link: s.link ?? null,
        // Runs noted before Codex could run here were Claude Code's.
        runs: (s.runs ?? []).map((r) => ({ ...r, tool: r.tool === "codex" ? "codex" : "claude" })),
      };
    }
  } catch {
    /* not connected yet */
  }
  return { machineId: randomUUID(), remote: "off", share: "off", sharing: null, owner: null, link: null, runs: [] };
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

/** Whose accounts the CLIs use, whether they can run, and the saved logins and hellos: labels and times, never credentials. */
async function clis(): Promise<Clis> {
  if (runtime.clis && Date.now() - runtime.clis.at < CLIS_MS) return runtime.clis.value;
  const { helloState } = await import("./schedule"); // schedule.ts reads this file's state: loaded when needed, not at start
  const [live, hellos] = await Promise.all([liveState().catch(() => null), helloState().catch(() => ({ schedules: [], runs: {} }))]);
  const login = (provider: Provider) => {
    const l = live?.live[provider];
    return l && "label" in l ? l.label : null;
  };
  const state = (provider: Provider): ToolState => toolState(provider, live ? live.live[provider] : null);
  const value: Clis = {
    logins: { claude: login("claude"), codex: login("codex") },
    tools: { claude: state("claude"), codex: state("codex") },
    manage: { profiles: live?.profiles ?? [], schedules: hellos.schedules, hellos: hellos.runs },
  };
  runtime.clis = { at: Date.now(), value };
  return value;
}

async function deviceInfo(stored: Stored): Promise<DeviceInfo & { manage: DeviceManage }> {
  const { logins, tools, manage } = await clis();
  return {
    name: os.hostname(),
    os: osName(),
    platform: process.platform,
    arch: process.arch,
    version: pkg.version,
    logins,
    remote: stored.remote,
    share: effectiveShare(stored),
    tools,
    manage,
  };
}

/**
 * The activity report as it leaves this computer: without session titles
 * unless what sessions say reaches the website, and with what has each
 * conversation open now, when that takes messages (`open`, by conversation id).
 */
function report(activity: DeviceActivity, share: ShareLevel, open: Map<string, string>): DeviceActivity {
  return {
    ...activity,
    sessions: activity.sessions.map((s) => {
      const where = s.tool === "claude" ? open.get(s.id) : undefined;
      return { ...s, title: share !== "off" ? s.title : null, ...(where && { open: where }) };
    }),
  };
}

/** The Claude Code conversations open in a program here that takes messages (see inbox.ts), by id, with what that program is. */
async function openHere(): Promise<Map<string, string>> {
  const open = new Map<string, string>();
  for (const s of await liveSessions().catch(() => [])) {
    if (!open.has(s.sessionId)) open.set(s.sessionId, s.entrypoint && /^[\w.-]{1,40}$/.test(s.entrypoint) ? s.entrypoint : "unknown");
  }
  return open;
}

function agentFetch(link: Link, route: string, method: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
  return fetch(link.server + route, {
    method,
    headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function schedule(ms: number): void {
  clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => void tick(), ms);
}

/** Checks in right away, or right after the check-in under way, with what the CLIs say now. */
function soon(): void {
  runtime.clis = null;
  if (runtime.syncing) runtime.again = true;
  else schedule(0);
}

async function tick(): Promise<void> {
  runtime.syncing = true;
  try {
    await sync();
  } catch (err) {
    runtime.error = `Could not check in: ${reason(err)}`;
    runtime.pollMs = undefined;
  } finally {
    runtime.syncing = false;
  }
  const s = await load();
  if (!s.link) return; // idle until it is connected again
  const usual = s.remote !== "off" || effectiveShare(s) !== "off" ? SYNC_MS.quick : SYNC_MS.slow;
  // Sooner when the server asks (someone works with this computer), never busier than every 1.5 seconds.
  schedule(runtime.again ? 0 : runtime.pollMs ? Math.max(1_500, Math.min(runtime.pollMs, usual)) : usual);
  runtime.again = false;
}

/** Idempotent; at server start and with every request to the local API. */
export function startAgent(): void {
  if (runtime.started) return;
  runtime.started = true;
  readLoginPath();
  schedule(0);
}

async function sync(): Promise<void> {
  const stored = await load();
  const link = stored.link;
  if (!link) return;
  // The logs can be large: a check-in waits for the first read only, and later ones go on meanwhile.
  if (!runtime.scan) await rescan();
  else if (Date.now() - runtime.scan.at > SCAN_MS) void rescan();
  const activity = runtime.scan ? report(runtime.scan.activity, effectiveShare(stored), await openHere()) : null;
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
  const json = (await res.json().catch(() => ({}))) as {
    sharing?: unknown;
    run?: RunJob | null;
    transcripts?: TranscriptAsk[];
    images?: ImageAsk[];
    commands?: CommandJob[];
    pollMs?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? `${new URL(link.server).host} answered ${res.status}`);
  runtime.lastSync = Date.now();
  runtime.error = null;
  runtime.pollMs = typeof json.pollMs === "number" && Number.isFinite(json.pollMs) ? json.pollMs : undefined;
  if (sending) runtime.reported = outgoing;
  // Who else sees what, before anything they asked for: a server from before 0.7 says nothing, which shares nothing more.
  const sharing = sharingOf(json.sharing);
  if (JSON.stringify(sharing) !== JSON.stringify(stored.sharing)) {
    const was = effectiveShare(stored);
    const now = await update((s) => {
      s.sharing = sharing;
    });
    if (effectiveShare(now) !== was) soon(); // the next report says so, and carries titles or not
  }
  const share = sharing?.managedBy.length ? "on" : stored.share;
  if (json.run) {
    // Handed a session while running one (two check-ins crossed): say so rather than leave it hanging.
    if (runtime.running) {
      const busy = "This computer was running another session; start it again.";
      void agentFetch(link, `/api/agent/runs/${encodeURIComponent(json.run.id)}`, "POST", { events: [], status: "failed", result: { error: busy } }).catch(() => undefined);
    } else void execute(json.run, link);
  }
  for (const job of (json.commands ?? []).slice(0, 5)) {
    runtime.commands = runtime.commands.catch(() => undefined).then(() => runCommand(link, job, stored.owner?.email ?? null));
  }
  for (const ask of (json.transcripts ?? []).slice(0, 3)) await answerTranscript(link, ask, share);
  if (json.images?.length) await answerImages(link, json.images.slice(0, 6), share);
}

/** Reads the session logs again, one read at a time. A failed read keeps the last one: checking in matters more than the report. */
function rescan(): Promise<void> {
  runtime.scanning ??= scanActivity()
    .then(
      (fresh) => {
        runtime.scan = { ...fresh, at: fresh.activity.scannedAt };
      },
      () => undefined,
    )
    .finally(() => {
      runtime.scanning = null;
    });
  return runtime.scanning;
}

/** The session's log, from this computer's own scan: read again first when it is newer than the last read, or was replaced since. */
async function logFor(tool: Tool, sessionId: string): Promise<string | undefined> {
  const logOf = () => (SESSION_ID.test(sessionId) ? runtime.scan?.logs.get(`${tool}:${sessionId}`) : undefined);
  const file = logOf();
  if (file && existsSync(/* turbopackIgnore: true */ file)) return file;
  await rescan();
  return logOf();
}

/**
 * Sends the images of a session someone opened, read again from its log, one
 * request each, while what sessions say may reach the website: nothing larger
 * than MAX_IMAGE_BYTES, which says how large it is instead.
 */
async function answerImages(link: Link, asks: ImageAsk[], share: ShareLevel): Promise<void> {
  const bySession = new Map<string, ImageAsk[]>();
  for (const ask of asks) {
    if ((ask.tool !== "claude" && ask.tool !== "codex") || typeof ask.sessionId !== "string" || !Number.isInteger(ask.n) || ask.n < 0) continue;
    const key = `${ask.tool}:${ask.sessionId}`;
    bySession.set(key, [...(bySession.get(key) ?? []), ask]);
  }
  for (const group of bySession.values()) {
    const { tool, sessionId } = group[0];
    const send = (n: number, answer: { type: string; data: string } | { error: string }) =>
      agentFetch(link, "/api/agent/images", "POST", { tool, sessionId, n, ...answer }, IMAGE_TIMEOUT_MS).catch(() => undefined);
    let found = new Map<number, LoggedImage>();
    let error: string | null = null;
    if (share === "off") error = "This computer keeps what its sessions say to itself.";
    else {
      const file = await logFor(tool, sessionId);
      if (!file) error = "That session is not on this computer, or is more than 30 days old.";
      else {
        try {
          found = await readImages(tool, file, new Set(group.map((a) => a.n)));
        } catch (err) {
          error = `Could not read the session's log: ${reason(err)}`;
        }
      }
    }
    for (const { n } of group) {
      const image = found.get(n);
      const bytes = image ? decodedBytes(image.data) : 0;
      if (!image) await send(n, { error: error ?? "That image is not in the session's log any more." });
      else if (bytes > MAX_IMAGE_BYTES) await send(n, { error: `Too large to send here (${(bytes / 1_000_000).toFixed(1)} MB).` });
      else await send(n, { type: image.type, data: image.data });
    }
  }
}

/**
 * Reads a session's transcript for the dashboard and sends it, if what
 * sessions say may reach the website (the server keeps it to whoever sees the
 * session). Only a session from this computer's own scan: the server names
 * it, the scan says which file it is.
 */
async function answerTranscript(link: Link, ask: TranscriptAsk, share: ShareLevel): Promise<void> {
  const file = share !== "off" && typeof ask.sessionId === "string" ? await logFor(ask.tool, ask.sessionId) : undefined;
  let answer: { events?: TranscriptEvent[]; error?: string };
  if (share === "off") answer = { error: "This computer keeps what its sessions say to itself." };
  else if ((ask.tool !== "claude" && ask.tool !== "codex") || !file) answer = { error: "That session is not on this computer, or is more than 30 days old." };
  else answer = await readTranscript(ask.tool, file).then((events) => ({ events }), (err: unknown) => ({ error: `Could not read the session's log: ${reason(err)}` }));
  await agentFetch(link, "/api/agent/transcripts", "POST", { tool: ask.tool, sessionId: ask.sessionId, ...answer }).catch(() => undefined);
}

const localId = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const MODES: ScheduleMode[] = ["at", "reset", "every-reset"];

/**
 * Does what the owner asked from the website, the way the This machine panel
 * would, and says how it went. Only its owner's commands: the server sends no
 * others, and this checks anyway.
 */
async function runCommand(link: Link, job: CommandJob, owner: string | null): Promise<void> {
  let ok = false;
  let message: string;
  try {
    if (!owner || job.by !== owner) throw new Error("Only this computer's owner manages it from the website.");
    const { actions } = await import("./schedule");
    const a = job.args ?? {};
    const profileId = localId(a.profileId);
    if (job.kind === "save") {
      if (a.provider !== "claude" && a.provider !== "codex") throw new Error("Unknown CLI.");
      await actions.save(a.provider);
      message = "Saved.";
    } else if (job.kind === "cancel") {
      const scheduleId = localId(a.scheduleId);
      if (!scheduleId) throw new Error("Unknown scheduled hello.");
      await actions.cancel(scheduleId);
      message = "Cancelled.";
    } else if (!profileId) {
      throw new Error("Unknown saved login.");
    } else if (job.kind === "switch") {
      await actions.switch(profileId);
      message = "Switched.";
    } else if (job.kind === "hello") {
      await actions.hello(profileId);
      message = "Said hello: its 5-hour window is running.";
    } else if (job.kind === "schedule") {
      const mode = a.mode as ScheduleMode;
      if (!MODES.includes(mode)) throw new Error("Unknown schedule.");
      await actions.schedule(profileId, mode, typeof a.at === "number" && Number.isFinite(a.at) ? a.at : undefined);
      message = "Scheduled.";
    } else {
      throw new Error("Unknown command.");
    }
    ok = true;
  } catch (err) {
    message = reason(err);
  }
  await agentFetch(link, "/api/agent/commands", "POST", { id: job.id, ok, message }).catch(() => undefined);
  soon(); // the website sees the change with the next check-in
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
    s.sharing = null; // the account's own, from the first check-in
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
    s.sharing = null;
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

/** Whether what sessions say may reach the website. Turning it off also has the server drop the transcripts it keeps from here. */
export async function setShare(level: ShareLevel): Promise<void> {
  await update((s) => {
    s.share = level;
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
    sharing: s.sharing,
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
  if (job.resume !== null && (typeof job.resume !== "string" || !SESSION_ID.test(job.resume))) return "Unknown conversation.";
  const owner = job.by !== null && job.by === stored.owner?.email;
  // Someone else from the owner's teams (the server says who may; this holds it to what): all of a member's work, or
  // what the owner shares, a project or the one chat.
  const shared = stored.sharing;
  const project = projectName(runtime.scan?.activity ?? null, job.tool, job.project);
  const theirs = Boolean(
    shared && (shared.managedBy.length > 0 || shared.all || shared.projects.includes(project) || (job.resume !== null && shared.sessions.includes(`${job.tool}:${job.resume}`))),
  );
  if (!owner && !theirs) return "Its owner does not share that project.";
  if (job.resume !== null) {
    // A conversation a remote session started here, or one of this computer's own, for its owner, and for the
    // others only when what sessions say reaches the website: the reply can tell what was said before.
    const fromHere = stored.runs.some((r) => r.sessionId === job.resume && !r.resumed && r.project === job.project && r.tool === job.tool);
    const own = runtime.scan?.activity.sessions.some((s) => s.id === job.resume && s.tool === job.tool && s.path === job.project);
    if (!fromHere && !(own && (owner || effectiveShare(stored) !== "off"))) return "That conversation cannot be continued from the website on this computer.";
  }
  return null;
}

/**
 * Why a conversation has to be continued where it is open, or null: a program
 * here has it open that takes no messages (Codex, or Claude Code before 2.1.234
 * in a terminal; one that takes them gets the message, see intoOpen). That
 * program keeps what was said to itself, so a turn added from here would be
 * missing from what it shows and says next.
 */
async function heldOpen(job: RunJob): Promise<string | null> {
  if (job.resume === null || !(await conversationOpen(job.resume))) return null;
  return job.tool === "claude"
    ? "That conversation is open in a program on this computer that keeps its own copy of it and takes no messages from other programs (Claude Code 2.1.234 or later does): continue it there, or close it there and send again."
    : "That conversation is open in Codex on this computer, which keeps its own copy of it: continue it there, or close it there and send again.";
}

/**
 * What a chat in each permission mode may do without asking at the computer,
 * as the level a message into it needs: Plan changes nothing; Ask permissions
 * and Don't ask run what the settings allow and ask about or refuse the rest,
 * and Accept edits edits files too, as an Edit files session may. Auto and
 * Bypass permissions, or a mode not known, need full access.
 */
const MODE_NEEDS: Record<string, RemoteLevel> = { plan: "read", default: "edit", dontAsk: "edit", acceptEdits: "edit" };

/** The Claude app's names for the permission modes. */
const MODE_NAME: Record<string, string> = { plan: "Plan", default: "Ask permissions", dontAsk: "Don't ask", acceptEdits: "Accept edits", auto: "Auto", bypassPermissions: "Bypass permissions" };

type Plan = { refused: string } | { chat: OpenChat } | { cli: string };

/**
 * A message into a conversation open in a program here that takes messages
 * (see inbox.ts), or why not. It runs there with that session's own
 * permissions, so the level it was sent with must cover what that session may
 * do without asking: the Claude app notes each chat's permission mode, and
 * for any other program it is not known, which takes full access.
 */
async function intoOpen(job: RunJob, stored: Stored, session: LiveSession): Promise<Plan> {
  const place = openIn(session.entrypoint ?? "");
  const mode = session.entrypoint === "claude-desktop" ? await appChatMode(session.sessionId).catch(() => null) : null;
  const needs = (mode && MODE_NEEDS[mode]) || "full";
  const how = mode ? ` in ${MODE_NAME[mode] ?? mode} mode` : "";
  if (!levelAllows(job.mode, needs)) {
    const whose = mode ? "the chat's own permissions" : "that session's own permissions, which AI Cooldown can't see";
    return {
      refused: levelAllows(stored.remote, needs)
        ? `That conversation is open in ${place} here${how}, where a message runs with ${whose}: send it with "${REMOTE_LABEL[needs]}"${needs === "full" ? "" : " or more"}, or continue it there.`
        : `That conversation is open in ${place} here${how}, where a message runs with ${whose}: more than this computer lets remote sessions do ("${REMOTE_LABEL[stored.remote]}"). Continue it there, or close it there and send again.`,
    };
  }
  const log = await logFor(job.tool, session.sessionId);
  if (!log) return { refused: "That conversation's log is not on this computer (any more)." };
  // Its owner's message says it is from AI Cooldown; anyone else's, whose it is too, to whoever sits at the computer.
  const from = job.by === null || job.by === stored.owner?.email ? FROM : `${FROM} (${job.by})`;
  return { chat: { session, log, from, place, note: `Sent into the conversation open in ${place}${how}: it runs there, with the model and permissions it has there.` } };
}

/**
 * How this computer runs the session: into the program that has its
 * conversation open, when that takes messages; through the CLI in its
 * project's folder; or not at all, and why.
 */
async function planRun(job: RunJob, stored: Stored): Promise<Plan> {
  const refused = refusal(job, stored);
  if (refused) return { refused };
  const open = job.tool === "claude" && job.resume !== null ? await liveSession(job.resume) : null;
  if (open) return intoOpen(job, stored, open);
  const held = await heldOpen(job);
  if (held) return { refused: held };
  const cli = (await clis()).tools[job.tool];
  if (cli === "missing") return { refused: `${TOOL_NAME[job.tool]} is not installed on this computer.` };
  if (cli === "signed-out") {
    return {
      refused:
        job.tool === "claude"
          ? `The Claude Code CLI is not signed in on this computer${job.resume ? ", and that conversation is not open in the Claude app here: open it there, or sign the CLI in" : ": its owner signs it in"} once, under This machine.`
          : "The Codex CLI is not signed in on this computer: its owner signs it in once, under This machine.",
    };
  }
  return { cli: runtime.scan!.folders.get(job.project)! };
}

async function execute(job: RunJob, link: Link): Promise<void> {
  const stop = new AbortController();
  const run: LocalRun = {
    id: job.id,
    tool: job.tool,
    project: job.project,
    prompt: String(job.prompt).slice(0, 300),
    by: job.by,
    mode: job.mode,
    status: "running",
    at: Date.now(),
    sessionId: job.resume,
    resumed: job.resume !== null,
  };
  // Set before anything is awaited: the next check-in must say it is busy.
  runtime.running = { run, stop };
  const send = async (r: RunReport) => {
    const res = await agentFetch(link, `/api/agent/runs/${encodeURIComponent(job.id)}`, "POST", r);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { cancel: boolean };
  };
  let status: RunStatus = "failed";
  try {
    const plan = await planRun(job, await load());
    await update((s) => {
      s.runs = [run, ...s.runs.filter((r) => r.id !== run.id)].slice(0, KEEP_RUNS);
    });
    if ("refused" in plan) {
      await send({ events: [{ at: Date.now(), kind: "error", text: plan.refused }], status: "failed", result: { error: plan.refused } }).catch(() => undefined);
    } else if ("chat" in plan) {
      status = await runInbox(job, plan.chat, send, stop.signal);
    } else {
      const out = await runSession(job, plan.cli, send, stop.signal);
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
