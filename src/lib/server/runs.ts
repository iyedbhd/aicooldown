import type { InStatement } from "@libsql/client";
import type { Tool } from "../activity";
import { levelAllows, MAX_PROMPT, MODEL_NAME, REMOTE_LABEL, SESSION_ID, type RemoteLevel, type Run, type RunEvent, type RunEventKind, type RunJob, type RunResult, type RunStatus } from "../team";
import type { User } from "./auth";
import { decrypt, encrypt, newId, openJson, sealJson } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { deviceById, isOnline } from "./devices";
import { RequestError } from "./request-error";
import { adminOver, seesRun } from "./teams";

/*
 * Remote sessions: a prompt for Claude Code or Codex, queued here for one
 * computer, which picks it up when it next checks in, runs it in the project
 * and sends the output back as it comes. Who may start one: the computer's
 * owner, and the owners and admins of their teams. Who sees it: the
 * computer's owner, and the owners and admins of a team that both the owner
 * and whoever started it are in. What it may do: whatever the computer
 * allows, which it enforces itself too. Prompts, output and results are
 * encrypted at rest like provider tokens.
 */

/** A session no computer picked up in this long fails: nobody expects it to start hours later. */
const QUEUE_TTL_MS = 10 * 60_000;
/** A running session whose computer has not checked in for this long is given up. */
const LOST_MS = 10 * 60_000;
const MAX_EVENTS = 1_000;
const MAX_EVENT_TEXT = 4_000;
/** Sessions waiting or running on one computer at a time: it runs one, the rest queue. */
const MAX_PENDING = 3;
/** Sessions one person may start in a day. */
const MAX_PER_DAY = 100;
const EVENT_KINDS: RunEventKind[] = ["text", "tool", "output", "error", "info", "result"];
const FINISHED: RunStatus[] = ["done", "failed", "cancelled"];

type Row = Record<string, unknown>;

const SELECT = `SELECT r.*, d.info AS device_info, d.user_id AS device_user, u.email AS by_email
  FROM runs r JOIN devices d ON d.id = r.device_id LEFT JOIN users u ON u.id = r.created_by`;

const opt = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toRun(r: Row): Run {
  return {
    id: String(r.id),
    tool: String(r.tool) as Tool,
    deviceId: String(r.device_id),
    deviceName: String(openJson<{ name?: string }>(String(r.device_info)).name ?? "computer"),
    by: r.by_email === null ? null : String(r.by_email),
    project: String(r.project),
    prompt: decrypt(String(r.prompt)),
    mode: String(r.mode) as RemoteLevel,
    model: r.model === null ? null : String(r.model),
    resume: r.resume_session === null ? null : String(r.resume_session),
    status: String(r.status) as RunStatus,
    sessionId: r.session_id === null ? null : String(r.session_id),
    result: r.result === null ? null : openJson<RunResult>(String(r.result)),
    createdAt: Number(r.created_at),
    startedAt: opt(r.started_at),
    finishedAt: opt(r.finished_at),
  };
}

const failed = (error: string) => sealJson({ error } satisfies RunResult);

/** Fails what can no longer happen on these computers: queued too long, or running on one that went quiet. */
async function settleStale(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const now = Date.now();
  const list = placeholders(deviceIds.length);
  await db().batch(
    [
      {
        sql: `UPDATE runs SET status = 'failed', finished_at = ?, result = ? WHERE status = 'queued' AND created_at < ? AND device_id IN (${list})`,
        args: [now, failed("No computer picked it up in time. It has to be on, with AI Cooldown running."), now - QUEUE_TTL_MS, ...deviceIds],
      },
      {
        sql: `UPDATE runs SET status = 'failed', finished_at = ?, result = ? WHERE status = 'running'
          AND device_id IN (SELECT id FROM devices WHERE last_seen_at < ? AND id IN (${list}))`,
        args: [now, failed("The computer stopped checking in before the session finished."), now - LOST_MS, ...deviceIds],
      },
    ],
    "write",
  );
}

/**
 * The latest sessions on these computers that the viewer sees from `teamId`,
 * the team they are looking at (null for their own workspace): every one on
 * their own computers, and on the others' those started by someone in the team.
 */
export async function listRuns(deviceIds: string[], viewerId: string, teamId: string | null, limit = 60): Promise<Run[]> {
  await ensureSchema();
  await settleStale(deviceIds);
  const res = await db().execute({
    sql: `${SELECT} WHERE r.device_id IN (${placeholders(deviceIds.length)})
      AND (d.user_id = ? OR r.created_by IN (SELECT user_id FROM team_members WHERE team_id = ?))
      ORDER BY r.created_at DESC LIMIT ?`,
    args: [...deviceIds, viewerId, teamId, limit],
  });
  return res.rows.map((r) => toRun(r as Row));
}

const sees = (viewer: User, row: Row) => seesRun(viewer.id, String(row.device_user), row.created_by === null ? null : String(row.created_by));

/** The run, if the viewer may see it (see seesRun). */
async function visibleRun(viewer: User, id: string): Promise<Row> {
  await ensureSchema();
  const res = await db().execute({ sql: `${SELECT} WHERE r.id = ?`, args: [id] });
  const row = res.rows[0] as Row | undefined;
  if (!row || !(await sees(viewer, row))) throw new RequestError(404, "Session not found.");
  return row;
}

export async function createRun(viewer: User, raw: Record<string, unknown>): Promise<Run> {
  const device = typeof raw.deviceId === "string" ? await deviceById(raw.deviceId) : null;
  if (!device || !(await adminOver(viewer.id, device.userId))) throw new RequestError(404, "Computer not found.");
  const name = device.info.name;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw new RequestError(400, "Write what Claude should do.");
  if (prompt.length > MAX_PROMPT) throw new RequestError(400, `Keep the prompt under ${MAX_PROMPT.toLocaleString("en-US")} characters.`);
  const mode = raw.mode as RemoteLevel;
  if (mode !== "read" && mode !== "edit" && mode !== "full") throw new RequestError(400, "Pick what the session may do.");
  const tool = raw.tool === "codex" ? "codex" : raw.tool === "claude" || raw.tool === undefined ? "claude" : null;
  if (!tool) throw new RequestError(400, "Pick Claude Code or Codex.");
  const model = typeof raw.model === "string" && raw.model ? raw.model : null;
  if (model !== null && !MODEL_NAME.test(model)) throw new RequestError(400, "Unknown model.");
  const project = typeof raw.project === "string" ? raw.project : "";
  if (!device.activity?.projects.some((p) => p.path === project)) throw new RequestError(400, `Pick one of the projects ${name} reported.`);
  let resume: string | null = null;
  if (raw.resume) {
    // Only a conversation a remote session started, never one of the owner's own sessions on that computer,
    // and one the viewer sees: a conversation started from another team stays that team's.
    const own = typeof raw.resume === "string" && SESSION_ID.test(raw.resume) ? raw.resume : null;
    const found = own && (await db().execute({ sql: `${SELECT} WHERE r.device_id = ? AND r.project = ? AND r.tool = ? AND r.session_id = ? ORDER BY r.created_at DESC LIMIT 1`, args: [device.id, project, tool, own] }));
    const started = found ? (found.rows[0] as Row | undefined) : undefined;
    if (!started || !(await sees(viewer, started))) throw new RequestError(400, "Only a session started from here can be continued.");
    resume = own;
  }
  if (!isOnline(device)) throw new RequestError(409, `${name} is offline. A session starts on a computer that is on, with AI Cooldown running.`);
  if (!levelAllows(device.info.remote, mode)) {
    throw new RequestError(
      403,
      device.info.remote === "off"
        ? `Remote sessions are off on ${name}. Its owner can turn them on in AI Cooldown on that computer.`
        : `${name} allows sessions up to "${REMOTE_LABEL[device.info.remote]}".`,
    );
  }

  const now = Date.now();
  const counts = await db().execute({
    sql: `SELECT (SELECT COUNT(*) FROM runs WHERE device_id = ? AND status IN ('queued', 'running')) AS pending,
      (SELECT COUNT(*) FROM runs WHERE created_by = ? AND created_at > ?) AS today`,
    args: [device.id, viewer.id, now - 86400_000],
  });
  if (Number(counts.rows[0].pending) >= MAX_PENDING) throw new RequestError(429, `${MAX_PENDING} sessions are already waiting on ${name}. Start this one when one of them is done.`);
  if (Number(counts.rows[0].today) >= MAX_PER_DAY) throw new RequestError(429, `That is ${MAX_PER_DAY} sessions started in the last day, the most there can be. Try again later.`);
  const id = newId();
  await db().execute({
    sql: `INSERT INTO runs (id, device_id, tool, created_by, project, prompt, mode, model, resume_session, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    args: [id, device.id, tool, viewer.id, project, encrypt(prompt), mode, model, resume, now],
  });
  return { id, tool, deviceId: device.id, deviceName: name, by: viewer.email, project, prompt, mode, model, resume, status: "queued", sessionId: null, result: null, createdAt: now, startedAt: null, finishedAt: null };
}

/** The run and its output after event `after`. */
export async function getRun(viewer: User, id: string, after: number): Promise<{ run: Run; events: RunEvent[] }> {
  const row = await visibleRun(viewer, id);
  await settleStale([String(row.device_id)]);
  // The run before its events: a run read as finished has all its output in already, since both arrive in one batch.
  const fresh = await db().execute({ sql: `${SELECT} WHERE r.id = ?`, args: [id] });
  const events = await db().execute({ sql: "SELECT seq, at, kind, text FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 500", args: [id, after] });
  return {
    run: toRun(fresh.rows[0] as Row),
    events: events.rows.map((e) => ({ seq: Number(e.seq), at: Number(e.at), kind: String(e.kind) as RunEventKind, text: decrypt(String(e.text)) })),
  };
}

/** Stops a run: a queued one at once, a running one when its computer next reports. */
export async function cancelRun(viewer: User, id: string): Promise<void> {
  const row = await visibleRun(viewer, id);
  if (row.status === "queued") {
    await db().execute({ sql: "UPDATE runs SET status = 'cancelled', finished_at = ?, result = ? WHERE id = ? AND status = 'queued'", args: [Date.now(), failed("Cancelled before it started."), id] });
  } else if (row.status === "running") {
    await db().execute({ sql: "UPDATE runs SET cancel_requested = 1 WHERE id = ?", args: [id] });
  }
}

// ---- The computer's side, authenticated by its device token.

/**
 * The oldest queued run for this computer, now marked running, or null. Whoever
 * queued it must still be allowed to: they may have left the team meanwhile.
 */
export async function claimRun(deviceId: string, ownerId: string): Promise<RunJob | null> {
  await settleStale([deviceId]);
  for (;;) {
    const res = await db().execute({
      sql: `UPDATE runs SET status = 'running', started_at = ?
        WHERE id = (SELECT id FROM runs WHERE device_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1)
        RETURNING id, tool, project, prompt, mode, model, resume_session, created_by`,
      args: [Date.now(), deviceId],
    });
    const r = res.rows[0] as Row | undefined;
    if (!r) return null;
    if (!(await adminOver(String(r.created_by), ownerId))) {
      await db().execute({ sql: "UPDATE runs SET status = 'failed', finished_at = ?, result = ? WHERE id = ?", args: [Date.now(), failed("Whoever started it may no longer start sessions on this computer."), String(r.id)] });
      continue;
    }
    const by = await db().execute({ sql: "SELECT email FROM users WHERE id = ?", args: [String(r.created_by)] });
    return {
      id: String(r.id),
      tool: String(r.tool) as Tool,
      project: String(r.project),
      prompt: decrypt(String(r.prompt)),
      mode: String(r.mode) as RemoteLevel,
      model: r.model === null ? null : String(r.model),
      resume: r.resume_session === null ? null : String(r.resume_session),
      by: by.rows[0] ? String(by.rows[0].email) : null,
    };
  }
}

/** The computer says it runs nothing: what is still marked running there was cut off, by a restart or a crash. */
export async function interruptRuns(deviceId: string): Promise<void> {
  await db().execute({
    sql: "UPDATE runs SET status = 'failed', finished_at = ?, result = ? WHERE device_id = ? AND status = 'running'",
    args: [Date.now(), failed("AI Cooldown on the computer stopped before the session finished."), deviceId],
  });
}

function parseResult(raw: unknown): RunResult {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
  return { costUsd: num(v.costUsd), turns: num(v.turns), durationMs: num(v.durationMs), error: typeof v.error === "string" && v.error ? v.error.slice(0, 1000) : undefined };
}

/**
 * Output and progress from the computer running `runId`: new events, the
 * Claude Code session id, and at the end its status and result. Answers
 * whether someone asked to cancel it.
 */
export async function reportRun(deviceId: string, runId: string, body: Record<string, unknown>): Promise<{ cancel: boolean }> {
  const res = await db().execute({ sql: "SELECT status, cancel_requested FROM runs WHERE id = ? AND device_id = ?", args: [runId, deviceId] });
  const run = res.rows[0];
  if (!run) throw new RequestError(404, "Session not found.");
  // Given up on, or cancelled while queued: the computer should stop.
  if (run.status !== "running") return { cancel: true };

  const statements: InStatement[] = [];
  const events = (Array.isArray(body.events) ? body.events : [])
    .slice(0, 200)
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object" && EVENT_KINDS.includes((e as { kind: RunEventKind }).kind) && typeof (e as { text: unknown }).text === "string");
  if (events.length) {
    const last = await db().execute({ sql: "SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?", args: [runId] });
    let seq = Number(last.rows[0].seq);
    const now = Date.now();
    for (const e of events) {
      if (seq >= MAX_EVENTS) break;
      seq += 1;
      const at = typeof e.at === "number" && Number.isFinite(e.at) ? e.at : now;
      const text = seq === MAX_EVENTS ? "Output cut short here: this session wrote more than is kept." : String(e.text).slice(0, MAX_EVENT_TEXT);
      statements.push({ sql: "INSERT INTO run_events (run_id, seq, at, kind, text) VALUES (?, ?, ?, ?, ?)", args: [runId, seq, at, seq === MAX_EVENTS ? "info" : String(e.kind), encrypt(text)] });
    }
  }
  if (typeof body.sessionId === "string" && SESSION_ID.test(body.sessionId)) {
    statements.push({ sql: "UPDATE runs SET session_id = ? WHERE id = ?", args: [body.sessionId, runId] });
  }
  if (FINISHED.includes(body.status as RunStatus)) {
    statements.push({ sql: "UPDATE runs SET status = ?, finished_at = ?, result = ? WHERE id = ?", args: [String(body.status), Date.now(), sealJson(parseResult(body.result)), runId] });
  }
  if (statements.length) await db().batch(statements, "write");
  return { cancel: Number(run.cancel_requested) === 1 };
}
