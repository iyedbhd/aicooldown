import type { ScheduleMode } from "../local";
import { CHAT_VERSION, TOOL_NAME, versionAtLeast, type Command, type CommandKind } from "../team";
import type { User } from "./auth";
import { openJson, sealJson, newId } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";
import { deviceById, heatDevice } from "./devices";
import { RequestError } from "./request-error";

/*
 * What a computer's owner has it do from the website with the CLI logins and
 * hellos it keeps: switch the login a CLI uses, save the current one, say
 * hello to start a 5-hour window, schedule a hello or cancel one. Queued here,
 * handed to the computer when it next checks in (marked running, so it is
 * never done twice), and answered with how it went. Only the owner sends
 * them, and the computer checks that too; deleting a saved login stays on the
 * computer itself.
 */

/** A command no computer took or answered in this long failed. */
const STALE_MS = 10 * 60_000;
/** Commands waiting for one computer at a time. */
const MAX_WAITING = 5;
const SHOWN = 8;
const KINDS: CommandKind[] = ["switch", "save", "hello", "schedule", "cancel"];
const MODES: ScheduleMode[] = ["at", "reset", "every-reset"];

type Row = Record<string, unknown>;

/** A command as the computer receives it. */
export type CommandJob = { id: string; kind: CommandKind; args: Record<string, unknown>; by: string | null };

function toCommand(r: Row): Command {
  return {
    id: String(r.id),
    kind: String(r.kind) as CommandKind,
    label: String(r.label),
    status: String(r.status) as Command["status"],
    message: r.message === null ? null : String(r.message),
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  };
}

async function settleStale(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  await db().execute({
    sql: `UPDATE device_commands SET status = 'failed', message = 'The computer did not answer. It has to be on, with AI Cooldown running.', finished_at = ?
      WHERE status IN ('queued', 'running') AND created_at < ? AND device_id IN (${placeholders(deviceIds.length)})`,
    args: [Date.now(), Date.now() - STALE_MS, ...deviceIds],
  });
}

/** The latest commands for these computers, newest first, by computer. */
export async function recentCommands(deviceIds: string[]): Promise<Map<string, Command[]>> {
  const out = new Map<string, Command[]>();
  if (deviceIds.length === 0) return out;
  await settleStale(deviceIds);
  const res = await db().execute({
    sql: `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY created_at DESC) AS n FROM device_commands
      WHERE device_id IN (${placeholders(deviceIds.length)})) WHERE n <= ? ORDER BY created_at DESC`,
    args: [...deviceIds, SHOWN],
  });
  for (const r of res.rows as Row[]) {
    const list = out.get(String(r.device_id)) ?? [];
    list.push(toCommand(r));
    out.set(String(r.device_id), list);
  }
  return out;
}

/** Queues a command for one of the viewer's own computers. */
export async function createCommand(viewer: User, raw: Record<string, unknown>): Promise<Command> {
  const device = typeof raw.deviceId === "string" ? await deviceById(raw.deviceId) : null;
  if (!device || device.userId !== viewer.id) throw new RequestError(404, "Computer not found. Only a computer's owner manages its logins.");
  if (!device.connected) throw new RequestError(409, `${device.info.name} is disconnected.`);
  if (!versionAtLeast(device.info.version, CHAT_VERSION)) throw new RequestError(409, `Update AI Cooldown on ${device.info.name} to ${CHAT_VERSION} or later to manage it from here.`);
  const kind = raw.kind as CommandKind;
  if (!KINDS.includes(kind)) throw new RequestError(400, "Unknown command.");
  const profiles = device.manage?.profiles ?? [];
  const profile = typeof raw.profileId === "string" ? profiles.find((p) => p.id === raw.profileId) : undefined;
  let args: Record<string, unknown>;
  let label: string;
  if (kind === "save") {
    if (raw.provider !== "claude" && raw.provider !== "codex") throw new RequestError(400, "Pick Claude Code or Codex.");
    args = { provider: raw.provider };
    label = `Save the login ${TOOL_NAME[raw.provider]} uses now`;
  } else if (kind === "cancel") {
    const scheduled = device.manage?.schedules.find((s) => s.id === raw.scheduleId);
    if (!scheduled) throw new RequestError(404, "That scheduled hello is not on this computer (any more).");
    args = { scheduleId: scheduled.id };
    label = `Cancel the hello scheduled with ${profiles.find((p) => p.id === scheduled.profileId)?.label ?? "a saved login"}`;
  } else {
    if (!profile) throw new RequestError(404, "That saved login is not on this computer (any more).");
    args = { profileId: profile.id };
    if (kind === "switch") label = `Switch ${TOOL_NAME[profile.provider]} to ${profile.label}`;
    else if (kind === "hello") label = `Say hello with ${profile.label}`;
    else {
      const mode = raw.mode as ScheduleMode;
      if (!MODES.includes(mode)) throw new RequestError(400, "Pick when to say hello.");
      const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : undefined;
      if (mode === "at" && (at === undefined || at < Date.now() - 60_000 || at > Date.now() + 30 * 86400_000)) throw new RequestError(400, "Pick a time within the next 30 days.");
      args = { profileId: profile.id, mode, at };
      label = `Say hello with ${profile.label} ${mode === "at" ? `at ${new Date(at!).toISOString()}` : mode === "reset" ? "at the next reset" : "after every reset"}`;
    }
  }
  await ensureSchema();
  const waiting = await db().execute({ sql: "SELECT COUNT(*) AS n FROM device_commands WHERE device_id = ? AND status IN ('queued', 'running')", args: [device.id] });
  if (Number(waiting.rows[0].n) >= MAX_WAITING) throw new RequestError(429, `${MAX_WAITING} commands are already waiting for ${device.info.name}.`);
  const now = Date.now();
  const id = newId();
  await db().execute({
    sql: "INSERT INTO device_commands (id, device_id, created_by, kind, args, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
    args: [id, device.id, viewer.id, kind, sealJson(args), label, now],
  });
  await heatDevice(device.id);
  return { id, kind, label, status: "queued", message: null, createdAt: now, finishedAt: null };
}

// ---- The computer's side, authenticated by its device token.

/** The commands waiting for this computer, oldest first, now marked running. Only its owner's. */
export async function takeCommands(deviceId: string, ownerId: string): Promise<CommandJob[]> {
  await settleStale([deviceId]);
  const res = await db().execute({
    sql: `UPDATE device_commands SET status = 'running'
      WHERE id IN (SELECT id FROM device_commands WHERE device_id = ? AND created_by = ? AND status = 'queued' ORDER BY created_at LIMIT ?)
      RETURNING id, kind, args, created_at`,
    args: [deviceId, ownerId, MAX_WAITING],
  });
  if (res.rows.length === 0) return [];
  const owner = await db().execute({ sql: "SELECT email FROM users WHERE id = ?", args: [ownerId] });
  const by = owner.rows[0] ? String(owner.rows[0].email) : null;
  return (res.rows as Row[])
    .sort((a, b) => Number(a.created_at) - Number(b.created_at))
    .map((r) => ({ id: String(r.id), kind: String(r.kind) as CommandKind, args: openJson<Record<string, unknown>>(String(r.args)), by }));
}

/** How a command went: `{ id, ok, message }`. */
export async function reportCommand(deviceId: string, raw: Record<string, unknown>): Promise<void> {
  if (typeof raw.id !== "string") throw new RequestError(400, "id is required.");
  const message = typeof raw.message === "string" && raw.message ? raw.message.slice(0, 500) : null;
  await db().execute({
    sql: "UPDATE device_commands SET status = ?, message = ?, finished_at = ? WHERE id = ? AND device_id = ? AND status = 'running'",
    args: [raw.ok === true ? "done" : "failed", message, Date.now(), raw.id, deviceId],
  });
}
