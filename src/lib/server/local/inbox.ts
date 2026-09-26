import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { SESSION_ID } from "@/lib/team";
import { livePlace } from "./cli";

/*
 * Claude Code sessions running on this computer, as Claude Code lists them for
 * one another (a record per running session under ~/.claude/sessions), and
 * messages into them the way one session messages another (its cross-session
 * messaging, in Claude Code 2.1.234 or later): a line to the session's inbox,
 * a named pipe on Windows and a socket elsewhere, authenticated with the
 * per-session key Claude Code keeps beside the record, which only this
 * computer's user can read. A chat open in the Claude app runs such a session,
 * so a message goes into the chat itself, on the app's login: the Claude Code
 * CLI needs none. The session takes it as a message from another program, not
 * as its user typing: it cannot answer a permission prompt, commands in it do
 * not run, and a session that skips permission prompts asks at the computer
 * before taking it.
 */

/** A Claude Code session running here that takes messages. */
export type LiveSession = {
  pid: number;
  /** When its process started, as Claude Code notes it: with the pid, which process it is. */
  procStart: string | null;
  startedAt: number;
  /** The conversation it has open (a SESSION_ID). */
  sessionId: string;
  /** What it runs in, as Claude Code says: "claude-desktop" (the Claude app), "cli" (a terminal), "claude-vscode" and so on. */
  entrypoint: string | null;
  /** Its inbox: a named pipe on Windows, a socket elsewhere. */
  inbox: string;
};

/** What a running session does now: "busy" with a turn, "idle", or "waiting" for an answer at the computer, and since when; null where it does not say. */
export type SessionState = { sessionId: string | null; status: string | null; since: number | null; waitingFor: string | null };

/** Who AI Cooldown's messages say they are from; Claude Code shows each as "Message from @AI Cooldown". */
export const FROM = "AI Cooldown";

const TAG = "cross-session-message";
const RECORD = /^(\d{1,10})\.json$/;
const KEY = /^(\d{1,10})\.[0-9a-f]{64}\.key$/;
const HEX32 = /^[0-9a-f]{32}$/;
/** An inbox where Claude Code makes them: its named pipe on Windows, a socket file elsewhere. */
const INBOX = process.platform === "win32" ? /^\\\\[.?]\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i : /^\/\S+\.sock$/;
/** Records and keys are a few hundred bytes. */
const MAX_FILE = 64 * 1024;
const SEND_MS = 5_000;

const sessionsDir = () => path.join(/* turbopackIgnore: true */ livePlace("claude").dir, "sessions");

const str = (v: unknown, max = 200) => (typeof v === "string" && v ? v.slice(0, max) : null);

async function readSmall(file: string): Promise<{ json: Record<string, unknown>; mtimeMs: number } | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE) return null;
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? { json: json as Record<string, unknown>, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Whether process `pid` is running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The sessions running here that take messages, the newest first. */
export async function liveSessions(): Promise<LiveSession[]> {
  const dir = sessionsDir();
  const found: LiveSession[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const pid = Number(RECORD.exec(name)?.[1]);
    if (!pid) continue;
    const r = (await readSmall(path.join(dir, name)))?.json;
    const inbox = str(r?.messagingSocketPath);
    if (!r || r.pid !== pid || typeof r.sessionId !== "string" || !SESSION_ID.test(r.sessionId) || !inbox || !INBOX.test(inbox) || !running(pid)) continue;
    const startedAt = typeof r.startedAt === "number" ? r.startedAt : 0;
    found.push({ pid, procStart: str(r.procStart), startedAt, sessionId: r.sessionId, entrypoint: str(r.entrypoint, 40), inbox });
  }
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

/** The session running here with conversation `id` open, if one takes messages. */
export async function liveSession(id: string): Promise<LiveSession | null> {
  return (await liveSessions()).find((s) => s.sessionId === id) ?? null;
}

/** What session `s` does now; null once its process has stopped. */
export async function sessionState(s: LiveSession): Promise<SessionState | null> {
  const r = (await readSmall(path.join(sessionsDir(), `${s.pid}.json`)))?.json;
  if (!r || r.pid !== s.pid || str(r.procStart) !== s.procStart || !running(s.pid)) return null;
  return {
    sessionId: str(r.sessionId),
    status: str(r.status, 20),
    since: typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : null,
    waitingFor: str(r.waitingFor, 100),
  };
}

/**
 * The key to session `s`'s inbox, which Claude Code writes to a file beside the
 * record when it starts, for its own sessions to authenticate to each other.
 * Windows requires it; only this computer's user can read the file.
 */
async function inboxKey(s: LiveSession): Promise<string> {
  const dir = sessionsDir();
  const keys: { token: string; procStart: string | null; mtimeMs: number }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (Number(KEY.exec(name)?.[1]) !== s.pid) continue;
    const file = await readSmall(path.join(dir, name));
    const token = file?.json.peerToken;
    if (file && typeof token === "string" && HEX32.test(token)) keys.push({ token, procStart: str(file.json.procStart), mtimeMs: file.mtimeMs });
  }
  // Its own notes the same process start; else the newest, since one left by an earlier process with its pid is older.
  const key = keys.find((k) => s.procStart !== null && k.procStart === s.procStart) ?? keys.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!key) throw new Error("the key to its inbox is not there");
  return key.token;
}

/** A sender's name as Claude Code takes one, unchanged: plain characters, no quotes or brackets, and short; else just AI Cooldown. */
function senderName(name: string): string {
  const plain = name
    .replace(/[^\w @.+()-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain && plain.length <= 60 ? plain : FROM;
}

/** `text` as one Claude Code session says something to another: who says it, in a tag the text cannot close early. */
function envelope(text: string, from: string): string {
  const body = text.replace(new RegExp(`<(/?${TAG})`, "gi"), "‹$1");
  return `<${TAG} from-name="${senderName(from)}">\n${body}\n</${TAG}>`;
}

/** What AI Cooldown said in a message it put into a session (see sendMessage), as the session's log keeps it; null for anything else. */
export function sentMessage(text: string): string | null {
  const m = new RegExp(`<${TAG}\\b[^>]*\\bfrom-name="${FROM}[^"]*"[^>]*>\\n([\\s\\S]*?)\\n</${TAG}>`).exec(text);
  return m ? m[1] : null;
}

/** Writes `lines` to an inbox and closes the connection. */
function write(inbox: string, lines: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect({ path: inbox });
    socket.setTimeout(SEND_MS, () => socket.destroy(Object.assign(new Error("it did not answer in time"), { code: "ETIMEDOUT" })));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(lines);
      // On macOS it ends a moment after writing, as Claude Code does itself.
      if (process.platform === "darwin") setTimeout(() => socket.end(), 150);
      else socket.end();
    });
    socket.once("close", (failed) => {
      if (!failed) resolve();
    });
  });
}

/**
 * Puts `text` in session `s`'s inbox, as said by `from`. Resolves once it is
 * written: the session takes it, holds it for approval or refuses it on its
 * own terms, and its log shows which.
 */
export async function sendMessage(s: LiveSession, text: string, from: string): Promise<void> {
  const token = await inboxKey(s);
  // The socket Claude Code made, not a link to somewhere else.
  if (process.platform !== "win32" && !(await lstat(s.inbox).then((i) => i.isSocket(), () => false))) throw new Error("its session is no longer running");
  const message = { msgV: 1, msg_id: randomUUID(), type: "user", message: { role: "user", content: envelope(text, from) }, priority: "next" };
  const lines = `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify(message)}\n`;
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(s.inbox, lines);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // An inbox momentarily busy with another message: Claude Code says to try again shortly.
      if ((code === "EBUSY" || code === "EAGAIN") && attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error("its session is no longer running");
      if (code === "ETIMEDOUT") throw new Error("its session did not answer in time");
      throw new Error(`its inbox refused the connection (${code || (err instanceof Error ? err.message : String(err))})`);
    }
  }
}
