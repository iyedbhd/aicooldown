import type { Tool } from "../activity";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageState, type ImageType } from "../team";
import type { User } from "./auth";
import { openRaw, sealRaw } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { heatDevice } from "./devices";
import { RequestError } from "./request-error";
import { keyOf, visibleDevice } from "./transcripts";

/*
 * A session's images: its transcript notes each one (see ImageRef), and when
 * someone who may read the session opens it, its computer reads it again from
 * the CLI's log on its next check-in and sends it, one image a request. Kept
 * here encrypted for three days (retention.ts), a hundred per computer, and
 * dropped as soon as the computer turns private: it sends them again when
 * asked. Only PNG, JPEG, GIF and WebP, checked to be what
 * they say they are, so a browser shows them as pictures and nothing else.
 */

/** A request its computer has not answered in this long fails. */
const ANSWER_MS = 10 * 60_000;
/** Images asked about in one request. */
const MAX_ASK = 24;
/** Images kept per computer: asking for more lets the ones read longest ago go. */
const MAX_PER_DEVICE = 100;
/** Images a computer is asked for at each check-in. */
const PER_CHECK_IN = 4;

type Row = Record<string, unknown>;

const SIGNATURE: Record<ImageType, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Which images: numbers as the transcript notes them. */
function numbers(raw: unknown): number[] {
  const list = typeof raw === "string" ? raw.split(",").map(Number) : Array.isArray(raw) ? raw : [];
  const ns = [...new Set(list.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 1_000_000))];
  if (ns.length === 0 || ns.length > MAX_ASK) throw new RequestError(400, `Ask about 1 to ${MAX_ASK} images at a time.`);
  return ns;
}

/** The session's computer, if the viewer may read the session (see transcripts.ts) and the computer lets that reach the website. */
async function readable(viewer: User, raw: Record<string, unknown>) {
  const k = keyOf(raw);
  await ensureSchema();
  const device = await visibleDevice(viewer, k);
  if (device.info.share === "off") throw new RequestError(403, `${device.info.name} keeps what its sessions say on the computer.`);
  return { k, device };
}

async function states(deviceId: string, tool: Tool, sessionId: string, ns: number[]): Promise<ImageState[]> {
  const now = Date.now();
  await db().execute({
    sql: "UPDATE session_images SET status = 'failed', error = ?, updated_at = ? WHERE device_id = ? AND status = 'pending' AND requested_at < ?",
    args: ["The computer did not answer. It has to be on, with AI Cooldown running.", now, deviceId, now - ANSWER_MS],
  });
  const res = await db().execute({
    sql: `SELECT n, status, error FROM session_images WHERE device_id = ? AND tool = ? AND session_id = ? AND n IN (${placeholders(ns.length)})`,
    args: [deviceId, tool, sessionId, ...ns],
  });
  const known = new Map(res.rows.map((r) => [Number(r.n), r as Row]));
  return ns.map((n) => {
    const r = known.get(n);
    return r ? { n, status: String(r.status) as ImageState["status"], error: r.error === null ? null : String(r.error) } : { n, status: "none", error: null };
  });
}

/**
 * Asks the session's computer for these images, the ones it has not sent
 * (and, with `retry`, the ones it could not), and says where each stands.
 * `{ deviceId, tool, sessionId, n: number[], retry? }`.
 */
export async function requestImages(viewer: User, raw: Record<string, unknown>): Promise<ImageState[]> {
  const { k, device } = await readable(viewer, raw);
  const ns = numbers(raw.n);
  if (!device.activity?.sessions.some((s) => s.tool === k.tool && s.id === k.sessionId)) throw new RequestError(404, "That session is not among the ones this computer reported.");
  const now = Date.now();
  const again = raw.retry === true ? "session_images.status = 'failed'" : "0";
  await db().batch(
    [
      ...ns.map((n) => ({
        sql: `INSERT INTO session_images (device_id, tool, session_id, n, status, requested_by, requested_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
          ON CONFLICT(device_id, tool, session_id, n) DO UPDATE SET status = 'pending', error = NULL, requested_by = excluded.requested_by, requested_at = excluded.requested_at WHERE ${again}`,
        args: [k.deviceId, k.tool, k.sessionId, n, viewer.id, now, now],
      })),
      {
        sql: "DELETE FROM session_images WHERE device_id = ? AND rowid NOT IN (SELECT rowid FROM session_images WHERE device_id = ? ORDER BY updated_at DESC LIMIT ?)",
        args: [k.deviceId, k.deviceId, MAX_PER_DEVICE],
      },
    ],
    "write",
  );
  const result = await states(k.deviceId, k.tool, k.sessionId, ns);
  if (result.some((s) => s.status === "pending")) await heatDevice(device.id);
  return result;
}

/** Where these images of a session stand: `?deviceId&tool&sessionId&n=1,2,3`. */
export async function imageStates(viewer: User, raw: Record<string, unknown>): Promise<ImageState[]> {
  const { k } = await readable(viewer, raw);
  return states(k.deviceId, k.tool, k.sessionId, numbers(raw.n));
}

/** An image the computer sent, to show as it is, or null while it is not here: `?deviceId&tool&sessionId&n`. */
export async function getImage(viewer: User, raw: Record<string, unknown>): Promise<{ type: ImageType; bytes: Buffer } | null> {
  const { k } = await readable(viewer, raw);
  const [n] = numbers(raw.n);
  const res = await db().execute({
    sql: "SELECT type, content FROM session_images WHERE device_id = ? AND tool = ? AND session_id = ? AND n = ? AND status = 'ready'",
    args: [k.deviceId, k.tool, k.sessionId, n],
  });
  const row = res.rows[0] as Row | undefined;
  return row ? { type: String(row.type) as ImageType, bytes: openRaw(row.content) } : null;
}

// ---- The computer's side, authenticated by its device token.

/** Images someone is waiting for from this computer. */
export async function imageRequests(deviceId: string): Promise<{ tool: Tool; sessionId: string; n: number }[]> {
  const res = await db().execute({
    sql: "SELECT tool, session_id, n FROM session_images WHERE device_id = ? AND status = 'pending' AND requested_at > ? ORDER BY requested_at, n LIMIT ?",
    args: [deviceId, Date.now() - ANSWER_MS, PER_CHECK_IN],
  });
  return res.rows.map((r) => ({ tool: String(r.tool) as Tool, sessionId: String(r.session_id), n: Number(r.n) }));
}

/** The computer's answer: `{ tool, sessionId, n, type, data }` (base64), or `{ tool, sessionId, n, error }`. Only for an image asked for. */
export async function storeImage(deviceId: string, raw: Record<string, unknown>): Promise<void> {
  const k = keyOf({ ...raw, deviceId });
  const [n] = numbers([raw.n]);
  let error = typeof raw.error === "string" && raw.error ? raw.error.slice(0, 300) : null;
  let type: ImageType | null = null;
  let content: Uint8Array | null = null;
  if (!error) {
    const bytes = typeof raw.data === "string" ? Buffer.from(raw.data, "base64") : Buffer.alloc(0);
    type = IMAGE_TYPES.includes(raw.type as ImageType) ? (raw.type as ImageType) : null;
    if (!type) error = "Not a kind of image shown here.";
    else if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) error = "Empty, or too large to keep.";
    else if (!SIGNATURE[type](bytes)) error = "Not the image it says it is.";
    else content = sealRaw(bytes);
  }
  await db().execute({
    sql: `UPDATE session_images SET status = ?, type = ?, content = ?, error = ?, updated_at = ?
      WHERE device_id = ? AND tool = ? AND session_id = ? AND n = ? AND status = 'pending'`,
    args: [error ? "failed" : "ready", error ? null : type, content, error, Date.now(), k.deviceId, k.tool, k.sessionId, n],
  });
}

/** Everything a computer sent, once it turns private. */
export async function dropImages(deviceId: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM session_images WHERE device_id = ?", args: [deviceId] });
}
