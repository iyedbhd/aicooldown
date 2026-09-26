import { NO_QUARTERS, QUARTERS_RE, type DeviceActivity, type ModelUsage, type ProjectActivity, type SessionActivity, type SessionWork, type TokenRow, type WorkRow } from "../activity";
import type { CliProfile, HelloRun, HelloSchedule, ScheduleMode } from "../local";
import { GRANT_NOTHING, MODEL_NAME, REMOTE_LEVELS, SESSION_ID, type Device, type DeviceInfo, type DeviceManage, type Grant, type RemoteLevel, type ShareLevel, type ToolState } from "../team";
import { decrypt, encrypt, newId, openCompact, openJson, randomToken, sealCompact, sealJson, sha256 } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { RequestError } from "./request-error";
import { forgetDevice, visibleActivity } from "./sharing";

/*
 * Computers running AI Cooldown that their owner connected to their account.
 * Each holds its own token (only its hash is stored here) and checks in on its
 * own: what it is, which accounts its CLIs are signed in with, what it lets
 * remote sessions do and whether what its sessions say reaches the website, the token usage
 * of the projects it works on, and for its owner, its saved CLI logins and
 * scheduled hellos. What it says is kept encrypted, like provider tokens.
 */

/** Computers one account may connect. */
const MAX_DEVICES = 20;

/** A computer that has not checked in for this long counts as offline; they check in every minute or faster. */
export const ONLINE_MS = 3 * 60_000;

/** How long a computer keeps checking in every few seconds after someone works with it from the website. */
const HOT_MS = 3 * 60_000;

type Row = Record<string, unknown>;

/** A device as the server works with it. */
export type DeviceRecord = {
  id: string;
  userId: string;
  info: DeviceInfo;
  /** The name its owner gave it, if any: see deviceName. */
  label: string | null;
  /** Its saved logins and scheduled hellos, for its owner. */
  manage: DeviceManage | null;
  lastSeenAt: number;
  /** Until when it should check in every few seconds: someone is working with it. */
  hotUntil: number;
  connected: boolean;
  /** With session titles when the computer lets them reach the website; who sees which sessions is up to listDevices. */
  activity: DeviceActivity | null;
  createdAt: number;
};

function toRecord(r: Row): DeviceRecord {
  const report = openJson<Record<string, unknown>>(String(r.info));
  const info = parseInfo(report);
  return {
    id: String(r.id),
    userId: String(r.user_id),
    info,
    label: r.label ? decrypt(String(r.label)) : null,
    manage: parseManage(report.manage),
    lastSeenAt: Number(r.last_seen_at),
    hotUntil: Number(r.hot_until ?? 0),
    connected: r.token_hash !== null,
    // Titles go the moment the computer stops sharing, before its next report.
    activity: r.activity ? parseActivity(openCompact(r.activity), info.share !== "off") : null,
    createdAt: Number(r.created_at),
  };
}

export const isOnline = (d: DeviceRecord, now = Date.now()) => d.connected && now - d.lastSeenAt < ONLINE_MS;

/** What a computer is called: the name its owner gave it, or else its host name. */
export const deviceName = (d: DeviceRecord) => d.label ?? d.info.name;

const MAX_LABEL = 60;

/** Names one of the user's computers; an empty name goes back to its host name. */
export async function renameDevice(userId: string, id: string, raw: unknown): Promise<void> {
  const label = typeof raw === "string" ? raw.trim().slice(0, MAX_LABEL) : "";
  await ensureSchema();
  const res = await db().execute({ sql: "UPDATE devices SET label = ? WHERE id = ? AND user_id = ?", args: [label ? encrypt(label) : null, id, userId] });
  if (res.rowsAffected === 0) throw new RequestError(404, "Computer not found.");
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

const TOOL_STATES: ToolState[] = ["ready", "signed-out", "missing"];
/** AI Cooldown before 0.6 said yes or no to sharing, which meant with the owner's teams. */
/** Before 0.7 on was "me" or "team", and before 0.6 true. */
const shareOf = (v: unknown): ShareLevel => (v === "on" || v === "me" || v === "team" || v === true ? "on" : "off");
/** Before 0.6 computers did not say: as then, a session finds out when it runs. */
const toolOf = (v: unknown): ToolState => (TOOL_STATES.includes(v as ToolState) ? (v as ToolState) : "ready");

/** A computer's report about itself, checked, since the team's admins see it. */
export function parseInfo(raw: unknown): DeviceInfo {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const logins = (v.logins && typeof v.logins === "object" ? v.logins : {}) as Record<string, unknown>;
  const tools = (v.tools && typeof v.tools === "object" ? v.tools : {}) as Record<string, unknown>;
  const login = (x: unknown) => (typeof x === "string" && x ? x.slice(0, 200) : null);
  const name = text(v.name, 100);
  if (!name) throw new RequestError(400, "The computer did not say its name.");
  return {
    name,
    os: text(v.os, 100),
    platform: text(v.platform, 20),
    arch: text(v.arch, 20),
    version: text(v.version, 40),
    logins: { claude: login(logins.claude), codex: login(logins.codex) },
    remote: REMOTE_LEVELS.includes(v.remote as RemoteLevel) ? (v.remote as RemoteLevel) : "off",
    share: shareOf(v.share),
    tools: { claude: toolOf(tools.claude), codex: toolOf(tools.codex) },
  };
}

const SCHEDULE_MODES: ScheduleMode[] = ["at", "reset", "every-reset"];
const localId = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const objects = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");

/** The saved logins and scheduled hellos a computer reports for its owner, checked. Null from one that reports none. */
export function parseManage(raw: unknown): DeviceManage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const profiles: CliProfile[] = [];
  for (const p of objects(v.profiles, 50)) {
    const id = localId(p.id);
    if (!id || (p.provider !== "claude" && p.provider !== "codex")) continue;
    profiles.push({ id, provider: p.provider, label: text(p.label, 200) || "saved login", plan: typeof p.plan === "string" ? p.plan.slice(0, 60) : undefined, active: p.active === true, savedAt: count(p.savedAt) });
  }
  const schedules: HelloSchedule[] = [];
  for (const s of objects(v.schedules, 50)) {
    const id = localId(s.id);
    const profileId = localId(s.profileId);
    if (!id || !profileId || !SCHEDULE_MODES.includes(s.mode as ScheduleMode)) continue;
    schedules.push({ id, profileId, mode: s.mode as ScheduleMode, at: count(s.at), createdAt: count(s.createdAt) });
  }
  const hellos: Record<string, HelloRun> = {};
  const given = v.hellos && typeof v.hellos === "object" ? Object.entries(v.hellos as Record<string, unknown>).slice(0, 50) : [];
  for (const [id, run] of given) {
    if (!localId(id) || !run || typeof run !== "object") continue;
    const r = run as Record<string, unknown>;
    hellos[id] = { at: count(r.at), ok: r.ok === true, message: text(r.message, 300), scheduled: r.scheduled === true };
  }
  return { profiles, schedules, hellos };
}

/** What a computer says about itself when it connects or checks in: its info, and what its owner manages from the website. */
export const parseReport = (raw: unknown) => ({ info: parseInfo(raw), manage: parseManage((raw as { manage?: unknown } | null)?.manage) });

const MAX_PROJECTS = 300;
const MAX_ROWS = 500;
/** Rows across all projects: a month of heavy use is a few thousand. */
const MAX_TOTAL_ROWS = 20_000;
/** A project's days of work, and all projects': a day each at most. */
const MAX_WORK_ROWS = 100;
const MAX_TOTAL_WORK_ROWS = 10_000;
const MAX_SESSIONS = 300;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A model's token counts, checked. */
function usageOf(x: Record<string, unknown>): ModelUsage {
  const cacheWrite = count(x.cacheWrite);
  return {
    model: text(x.model, 100) || "unknown",
    input: count(x.input),
    output: count(x.output),
    cacheWrite,
    cacheWrite1h: Math.min(count(x.cacheWrite1h), cacheWrite),
    cacheRead: count(x.cacheRead),
    messages: count(x.messages),
  };
}

/** A day's work, checked; null for one that does not parse. */
function workRowOf(x: Record<string, unknown>): WorkRow | null {
  if (typeof x.day !== "string" || !DAY.test(x.day)) return null;
  return {
    day: x.day,
    prompts: count(x.prompts),
    edits: count(x.edits),
    added: count(x.added),
    removed: count(x.removed),
    commands: count(x.commands),
    quarters: typeof x.quarters === "string" && QUARTERS_RE.test(x.quarters) ? x.quarters : NO_QUARTERS,
  };
}

/** A session's work, checked; undefined from a computer before 0.13, which does not report it. */
function sessionWorkOf(raw: unknown): SessionWork | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const x = raw as Record<string, unknown>;
  return { prompts: count(x.prompts), edits: count(x.edits), added: count(x.added), removed: count(x.removed), commands: count(x.commands), minutes: count(x.minutes) };
}

/** The sessions part of the report. Titles only come from a computer that says it shares them. */
function parseSessions(raw: unknown, titles: boolean): SessionActivity[] {
  const sessions: SessionActivity[] = [];
  for (const x of objects(raw, MAX_SESSIONS)) {
    const path = text(x.path, 500);
    if (!path || (x.tool !== "claude" && x.tool !== "codex") || typeof x.id !== "string" || !SESSION_ID.test(x.id)) continue;
    const work = sessionWorkOf(x.work);
    sessions.push({
      tool: x.tool,
      id: x.id,
      path,
      title: titles && typeof x.title === "string" && x.title ? x.title.slice(0, 200) : null,
      branch: typeof x.branch === "string" && x.branch ? x.branch.slice(0, 200) : null,
      source: typeof x.source === "string" && x.source ? x.source.slice(0, 60) : null,
      model: typeof x.model === "string" && MODEL_NAME.test(x.model) ? x.model : null,
      startedAt: count(x.startedAt),
      lastActive: count(x.lastActive),
      usage: objects(x.usage, 20).map(usageOf),
      subagents: count(x.subagents),
      ...(work && { work }),
      ...(typeof x.open === "string" && /^[\w.-]{1,40}$/.test(x.open) && { open: x.open }),
    });
  }
  return sessions;
}

/** The activity report, checked the same way. Rows that do not parse are left out, and session titles unless `titles`. */
export function parseActivity(raw: unknown, titles: boolean): DeviceActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const projects: ProjectActivity[] = [];
  let budget = MAX_TOTAL_ROWS;
  let workBudget = MAX_TOTAL_WORK_ROWS;
  for (const q of objects(v.projects, MAX_PROJECTS)) {
    const path = text(q.path, 500);
    if (!path || (q.tool !== "claude" && q.tool !== "codex")) continue;
    const rows: TokenRow[] = [];
    const given = objects(q.rows, Math.min(MAX_ROWS, budget));
    budget -= given.length;
    for (const x of given) {
      if (typeof x.day !== "string" || !DAY.test(x.day)) continue;
      rows.push({ day: x.day, ...usageOf(x) });
    }
    // A computer before 0.13 reports no work: none at all, rather than none done.
    const days = Array.isArray(q.work) ? objects(q.work, Math.min(MAX_WORK_ROWS, workBudget)) : null;
    if (days) workBudget -= days.length;
    projects.push({
      tool: q.tool,
      path,
      name: text(q.name, 200) || path,
      branch: typeof q.branch === "string" && q.branch ? q.branch.slice(0, 200) : null,
      lastActive: count(q.lastActive),
      sessions: count(q.sessions),
      rows,
      ...(days && { work: days.map(workRowOf).filter((w): w is WorkRow => w !== null) }),
    });
  }
  return { scannedAt: count(v.scannedAt), days: Math.min(count(v.days), 90), projects, sessions: parseSessions(v.sessions, titles) };
}

/**
 * Connects a computer to the account, or reconnects it with a fresh token:
 * one device per account and computer, so its history stays. Returns the
 * token the computer uses from then on; it is not stored.
 */
export async function registerDevice(userId: string, machineId: unknown, report: unknown): Promise<{ id: string; token: string }> {
  if (typeof machineId !== "string" || !/^[\w-]{8,64}$/.test(machineId)) throw new RequestError(400, "machineId is required.");
  const { info, manage } = parseReport(report);
  await ensureSchema();
  const known = await db().execute({
    sql: "SELECT COUNT(*) AS total, COALESCE(SUM(machine_id = ?), 0) AS this FROM devices WHERE user_id = ?",
    args: [machineId, userId],
  });
  if (Number(known.rows[0].this) === 0 && Number(known.rows[0].total) >= MAX_DEVICES) {
    throw new RequestError(409, `An account connects up to ${MAX_DEVICES} computers. Remove one on the Team page first.`);
  }
  const token = randomToken(32);
  const now = Date.now();
  const res = await db().execute({
    sql: `INSERT INTO devices (id, user_id, machine_id, token_hash, info, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, machine_id) DO UPDATE SET token_hash = excluded.token_hash, info = excluded.info, last_seen_at = excluded.last_seen_at
      RETURNING id`,
    args: [newId(), userId, machineId, sha256(token), sealJson({ ...info, manage }), now, now],
  });
  return { id: String(res.rows[0].id), token };
}

/** The device whose token the request carries (`Authorization: Bearer`), or null. */
export async function deviceFromRequest(req: Request): Promise<DeviceRecord | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT * FROM devices WHERE token_hash = ?", args: [sha256(token)] });
  return res.rows[0] ? toRecord(res.rows[0] as Row) : null;
}

/**
 * A check-in: what the computer says about itself now, and a new activity
 * report when it sent one. A computer checking in every few seconds while
 * someone works with it says the same thing most times: that is not written
 * again for a minute (being online is judged over three).
 */
export async function recordSync(device: DeviceRecord, info: DeviceInfo, manage: DeviceManage | null, activity: DeviceActivity | null | undefined): Promise<void> {
  const now = Date.now();
  const same = JSON.stringify(info) === JSON.stringify(device.info) && JSON.stringify(manage) === JSON.stringify(device.manage);
  if (activity === undefined && same && now - device.lastSeenAt < 60_000) return;
  const report = sealJson({ ...info, manage });
  await db().execute(
    activity === undefined
      ? { sql: "UPDATE devices SET info = ?, last_seen_at = ? WHERE id = ?", args: [report, now, device.id] }
      : { sql: "UPDATE devices SET info = ?, activity = ?, last_seen_at = ? WHERE id = ?", args: [report, activity && sealCompact(activity), now, device.id] },
  );
}

/** Someone works with this computer from the website: it checks in every few seconds for a while, so what they ask for starts at once. */
export async function heatDevice(id: string): Promise<void> {
  // Written once a minute at most, however often it is asked.
  const until = Date.now() + HOT_MS;
  await db().execute({ sql: "UPDATE devices SET hot_until = ? WHERE id = ? AND hot_until < ?", args: [until, id, until - 60_000] });
}

/** The computer disconnecting itself: its token stops working, its history stays. */
export async function unlinkDevice(id: string): Promise<void> {
  await db().execute({ sql: "UPDATE devices SET token_hash = NULL WHERE id = ?", args: [id] });
}

export async function deviceById(id: string): Promise<DeviceRecord | null> {
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT * FROM devices WHERE id = ?", args: [id] });
  return res.rows[0] ? toRecord(res.rows[0] as Row) : null;
}

/**
 * These users' devices as `viewerId` sees them, most recently seen first: the
 * projects and sessions each owner's grant shows (see sharing.ts), and the
 * saved logins and scheduled hellos for its owner only (the workspace adds
 * the owner's commands). Of an owner not `detailed` (someone who only shares
 * some work with the viewer), only computers with something shared, and of
 * those only what places a shared session: their name and whether they are on.
 */
export async function listDevices(userIds: string[], viewerId: string, grants: Map<string, Grant>, detailed: Set<string>): Promise<Device[]> {
  await ensureSchema();
  const res = await db().execute({ sql: `SELECT * FROM devices WHERE user_id IN (${placeholders(userIds.length)}) ORDER BY last_seen_at DESC`, args: userIds });
  const now = Date.now();
  return res.rows.flatMap((r) => {
    const d = toRecord(r as Row);
    const own = d.userId === viewerId;
    const activity = d.activity && visibleActivity(d.activity, grants.get(d.userId) ?? GRANT_NOTHING, d.id);
    if (!detailed.has(d.userId)) {
      if (!activity || (activity.projects.length === 0 && activity.sessions.length === 0)) return [];
      return [
        {
          ...d.info,
          name: deviceName(d),
          hostname: deviceName(d),
          label: null,
          os: "",
          platform: "",
          arch: "",
          version: "",
          logins: { claude: null, codex: null },
          remote: "off" as const,
          tools: { claude: "missing" as const, codex: "missing" as const },
          id: d.id,
          userId: d.userId,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          online: isOnline(d, now),
          connected: d.connected,
          activity,
          manage: null,
          commands: [],
        },
      ];
    }
    return [
      {
        ...d.info,
        name: deviceName(d),
        hostname: d.info.name,
        label: d.label,
        id: d.id,
        userId: d.userId,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        online: isOnline(d, now),
        connected: d.connected,
        activity,
        manage: own ? d.manage : null,
        commands: [],
      },
    ];
  });
}

/** Removes one of the user's own devices with its sessions. A computer still running AI Cooldown just stops being connected. */
export async function removeDevice(userId: string, id: string): Promise<void> {
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT id FROM devices WHERE id = ? AND user_id = ?", args: [id, userId] });
  if (!res.rows[0]) throw new RequestError(404, "Computer not found.");
  await db().batch(
    [
      { sql: "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE device_id = ?)", args: [id] },
      { sql: "DELETE FROM runs WHERE device_id = ?", args: [id] },
      { sql: "DELETE FROM session_transcripts WHERE device_id = ?", args: [id] },
      { sql: "DELETE FROM session_images WHERE device_id = ?", args: [id] },
      { sql: "DELETE FROM device_commands WHERE device_id = ?", args: [id] },
      { sql: "DELETE FROM devices WHERE id = ?", args: [id] },
    ],
    "write",
  );
  await forgetDevice(userId, id);
}
