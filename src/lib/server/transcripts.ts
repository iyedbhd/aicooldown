import type { Tool } from "../activity";
import { SESSION_ID, type RunEventKind, type Transcript } from "../team";
import type { User } from "./auth";
import { decrypt, encrypt } from "./crypto";
import { db, ensureSchema } from "./db";
import { deviceById, heatDevice, type DeviceRecord } from "./devices";
import { RequestError } from "./request-error";
import { accessTo, showsSession } from "./sharing";

/*
 * Session transcripts: the conversation of a Claude Code or Codex session,
 * which its computer reads from the CLI's log and sends when someone who sees
 * that session asks (see sharing.ts), and only while the computer lets what
 * sessions say reach the website. The computer is asked on its next check-in.
 * A transcript is kept here, encrypted like provider tokens, for a week
 * (retention.ts), and dropped as soon as its computer turns that off.
 */

/** A request its computer has not answered in this long fails. */
const ANSWER_MS = 10 * 60_000;
const MAX_EVENTS = 1_600;
const MAX_TEXT = 4_000;
/** All of a transcript's text together, as much as a computer sends: its latest part is kept. */
const MAX_CHARS = 1_500_000;
/** Transcripts kept per computer: asking for another lets the one updated longest ago go. */
const MAX_PER_DEVICE = 50;
const EVENT_KINDS: RunEventKind[] = ["user", "text", "tool", "output", "error", "info", "result", "image"];

type Row = Record<string, unknown>;
type Key = { deviceId: string; tool: Tool; sessionId: string };

export function keyOf(raw: Record<string, unknown>): Key {
  const { deviceId, tool, sessionId } = raw;
  if (typeof deviceId !== "string" || (tool !== "claude" && tool !== "codex") || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new RequestError(400, "deviceId, tool and sessionId are required.");
  }
  return { deviceId, tool, sessionId };
}

/** The session's computer, if the viewer sees the session: on their own computer, a member's of a team they run, or shared with them. */
export async function visibleDevice(viewer: User, k: Key): Promise<DeviceRecord> {
  const device = await deviceById(k.deviceId);
  const grant = device && (await accessTo(viewer.id, device.userId));
  if (!device || !grant) throw new RequestError(404, "Computer not found.");
  if (!showsSession(grant, device, k.tool, k.sessionId)) throw new RequestError(404, "That session is not among the ones you see on this computer.");
  return device;
}

function toTranscript(r: Row): Transcript {
  const events = r.content ? (JSON.parse(decrypt(String(r.content))) as { at: number; kind: RunEventKind; text: string }[]) : [];
  return {
    status: String(r.status) as Transcript["status"],
    events: events.map((e, i) => ({ seq: i + 1, ...e })),
    error: r.error === null ? null : String(r.error),
    requestedAt: Number(r.requested_at),
    updatedAt: Number(r.updated_at),
  };
}

const find = (k: Key) => db().execute({ sql: "SELECT * FROM session_transcripts WHERE device_id = ? AND tool = ? AND session_id = ?", args: [k.deviceId, k.tool, k.sessionId] });

/**
 * Asks for a session's transcript: the one already fetched, unless `refresh`,
 * or a fresh read by its computer, which answers within a minute or so.
 */
export async function requestTranscript(viewer: User, raw: Record<string, unknown>): Promise<Transcript> {
  const k = keyOf(raw);
  await ensureSchema();
  const device = await visibleDevice(viewer, k);
  if (device.info.share === "off") {
    throw new RequestError(403, `${device.info.name} keeps what its sessions say on the computer. Its owner can change that in AI Cooldown there, under This machine.`);
  }
  if (!device.activity?.sessions.some((s) => s.tool === k.tool && s.id === k.sessionId)) throw new RequestError(404, "That session is not among the ones this computer reported.");
  const now = Date.now();
  const existing = (await find(k)).rows[0] as Row | undefined;
  if (existing && existing.status !== "failed" && raw.refresh !== true) return toTranscript(existing);
  // A refresh keeps showing the last copy until the new one comes.
  await db().batch(
    [
      {
        sql: `INSERT INTO session_transcripts (device_id, tool, session_id, status, requested_by, requested_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)
          ON CONFLICT(device_id, tool, session_id) DO UPDATE SET status = 'pending', requested_by = excluded.requested_by, requested_at = excluded.requested_at, error = NULL`,
        args: [k.deviceId, k.tool, k.sessionId, viewer.id, now, now],
      },
      {
        sql: `DELETE FROM session_transcripts WHERE device_id = ? AND rowid NOT IN
          (SELECT rowid FROM session_transcripts WHERE device_id = ? ORDER BY updated_at DESC LIMIT ?)`,
        args: [k.deviceId, k.deviceId, MAX_PER_DEVICE],
      },
    ],
    "write",
  );
  await heatDevice(device.id);
  return toTranscript((await find(k)).rows[0] as Row);
}

/** The transcript as it stands, or null when nobody asked for it yet. */
export async function getTranscript(viewer: User, raw: Record<string, unknown>): Promise<Transcript | null> {
  const k = keyOf(raw);
  await ensureSchema();
  const device = await visibleDevice(viewer, k);
  // Turned private: what it sent is being dropped, and is not shown meanwhile.
  if (device.info.share === "off") return null;
  const now = Date.now();
  await db().execute({
    sql: "UPDATE session_transcripts SET status = 'failed', error = ?, updated_at = ? WHERE device_id = ? AND status = 'pending' AND requested_at < ?",
    args: ["The computer did not answer. It has to be on, with AI Cooldown running.", now, k.deviceId, now - ANSWER_MS],
  });
  const row = (await find(k)).rows[0] as Row | undefined;
  return row ? toTranscript(row) : null;
}

// ---- The computer's side, authenticated by its device token.

/** Transcripts someone is waiting for from this computer. */
export async function transcriptRequests(deviceId: string): Promise<{ tool: Tool; sessionId: string }[]> {
  const res = await db().execute({
    sql: "SELECT tool, session_id FROM session_transcripts WHERE device_id = ? AND status = 'pending' AND requested_at > ? ORDER BY requested_at LIMIT 3",
    args: [deviceId, Date.now() - ANSWER_MS],
  });
  return res.rows.map((r) => ({ tool: String(r.tool) as Tool, sessionId: String(r.session_id) }));
}

/** The computer's answer: `{ tool, sessionId, events }`, or `{ tool, sessionId, error }` when it will not or cannot. */
export async function storeTranscript(deviceId: string, raw: Record<string, unknown>): Promise<void> {
  const k = keyOf({ ...raw, deviceId });
  const events = (Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object" && EVENT_KINDS.includes((e as { kind: RunEventKind }).kind) && typeof (e as { text: unknown }).text === "string")
    .map((e) => ({ at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : 0, kind: e.kind as RunEventKind, text: String(e.text).slice(0, MAX_TEXT) }));
  let chars = 0;
  let from = events.length;
  while (from > 0 && chars + events[from - 1].text.length <= MAX_CHARS) chars += events[--from].text.length;
  events.splice(0, from);
  const error = typeof raw.error === "string" && raw.error ? raw.error.slice(0, 500) : null;
  // A failed read again keeps the copy read before.
  await db().execute({
    sql: "UPDATE session_transcripts SET status = ?, content = COALESCE(?, content), error = ?, updated_at = ? WHERE device_id = ? AND tool = ? AND session_id = ? AND status = 'pending'",
    args: [error ? "failed" : "ready", error ? null : encrypt(JSON.stringify(events)), error, Date.now(), k.deviceId, k.tool, k.sessionId],
  });
}

/** Everything fetched from a computer that stopped sharing session content. */
export async function dropTranscripts(deviceId: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM session_transcripts WHERE device_id = ?", args: [deviceId] });
}
