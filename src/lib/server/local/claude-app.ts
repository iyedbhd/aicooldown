import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, open, readdir, readFile, readlink, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatOperation, ChatPlace, ChatsResult, ClaudeAppChat, ClaudeAppPlace, ClaudeAppState } from "@/lib/claude-chats";
import { DATA_DIR } from "../data-dir";
import { livePlace, savedClaudeAccounts } from "./cli";

/*
 * The Claude app (Anthropic's desktop app) keeps its Code tab's sessions,
 * which people call chats, on this computer:
 *
 *   <the app's data>/claude-code-sessions/<account uuid>/<organization uuid>/local_<uuid>.json
 *
 * each naming the Claude Code conversation it continues (cliSessionId: a
 * transcript under ~/.claude/projects, beside its folder of subagents and tool
 * output, with its edit history under ~/.claude/file-history). Signed in with
 * another account, the app lists that account's folder only, so the chats of
 * the first seem gone, although they are all still here.
 *
 * Copying writes a chat into another account's folder as a new chat with its
 * own copy of the conversation, under new ids: continuing one never touches
 * the other, and the app, which keeps tombstones of deleted chats by id, never
 * confuses the two. Moving copies, then takes the chat out of the account it
 * was in, keeping that file for Undo. The app reads these folders when it
 * starts or switches account, so a copy shows there after switching to that
 * account or reopening the app; a chat open in the app can be copied but not
 * moved, since the app writes the chats it has open. What was copied where is
 * recorded here, for Undo and so each chat can say where its copies are.
 */

/**
 * A path to the user's own files, only known at run time. Kept out of the
 * build's file tracing, which takes paths it cannot work out for wildcards and
 * would pack whatever project files match them into the app.
 */
const at = (...parts: string[]) => path.join(/* turbopackIgnore: true */ ...parts);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_FILE = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
/** The app itself skips chat files larger than this. */
const MAX_CHAT_BYTES = 4 * 1024 * 1024;
/**
 * Worked in this recently, in the account the app is open with: the app may
 * write the chat again at any moment. The app dates a chat's activity between
 * turns only, while its conversation log is written as a turn goes, so the
 * files' times count too; copies keep their originals' times for that.
 */
const IN_USE_MS = 5 * 60_000;
const LEDGER = at(DATA_DIR, "claude-app-chats.json");
/** Chats moved away, kept for Undo. */
const BACKUPS = at(DATA_DIR, "claude-app-chats");
const MAX_OPERATIONS = 30;
/** Tied to the account a chat was in: its connectors, remote-control bridges, browser tab group, published artifacts. The app sets them up afresh. */
const ACCOUNT_BOUND = ["bridgeSessionIds", "envScopeId", "chromeTabGroupId", "publishedArtifacts", "toolSurfaceSnapshot"];

type Json = Record<string, unknown>;
/** What is known of an account: from ~/.claude.json, which the app and the CLI write their account to, and from saved CLI logins. */
type Known = { email?: string; org?: string; orgName?: string };
/** A copied chat: `clis` are its conversations' new ids, `bytes` its log's size when copied, `activity` the source's last activity. */
type LedgerItem = { title: string; source: string; copy: string; clis: string[]; activity: number; bytes?: number; backup?: string };
type LedgerOperation = Omit<ChatOperation, "items"> & { items: LedgerItem[] };
type Ledger = { names: Record<string, string>; known: Record<string, Known>; operations: LedgerOperation[] };
type RawChat = { id: string; file: string; json: Json; modified: number };
type RawPlace = ClaudeAppPlace & { dir: string; raw: RawChat[] };

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: string) => stat(p).then(() => true, () => false);
const text = (v: unknown) => (typeof v === "string" ? v : null);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function readJson(file: string): Promise<Json | null> {
  try {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? (json as Json) : null;
  } catch {
    return null;
  }
}

/** Written to a hidden temporary name, then renamed: the app never reads half a file, nor mistakes the temporary one for a chat. */
async function writeAtomic(file: string, content: string, modified?: number): Promise<void> {
  const temp = at(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(temp, content, { flag: "wx" });
  if (modified) await utimes(temp, new Date(modified), new Date(modified));
  await rename(temp, file);
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name);
}

/** One change to the app's folders at a time. */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// ---- Where things are.

/** The Claude app's data folder: %APPDATA%\Claude (Windows links the Microsoft Store version's there too), ~/Library/Application Support/Claude, ~/.config/Claude. */
async function appDir(): Promise<string | null> {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(at(process.env.APPDATA || at(home, "AppData", "Roaming"), "Claude"));
    // The Microsoft Store version, where Windows has not linked it into AppData.
    const packages = at(process.env.LOCALAPPDATA || at(home, "AppData", "Local"), "Packages");
    for (const name of await readdir(packages).catch(() => [] as string[])) {
      if (/^Claude_/i.test(name)) candidates.push(at(packages, name, "LocalCache", "Roaming", "Claude"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(at(home, "Library", "Application Support", "Claude"));
  } else {
    candidates.push(at(process.env.XDG_CONFIG_HOME || at(home, ".config"), "Claude"));
  }
  for (const dir of candidates) if (await isDir(at(dir, "claude-code-sessions"))) return dir;
  return null;
}

/** Whether the app is open: it holds its lockfile busy on Windows, and keeps a SingletonLock link to its process elsewhere. */
async function appRunning(dir: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      // Opened for writing without changing it: that fails while the app holds it.
      const handle = await open(at(dir, "lockfile"), "r+");
      await handle.close();
      return false;
    } catch (err) {
      return ["EBUSY", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "");
    }
  }
  try {
    const target = await readlink(at(dir, "SingletonLock"));
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where Claude Code keeps its conversations and edit history; the Claude app uses the same. */
const claudeHome = () => livePlace("claude").dir;

/** Every Claude Code conversation on this computer, by id. */
async function conversations(): Promise<Map<string, string>> {
  const root = at(claudeHome(), "projects");
  const found = new Map<string, string>();
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    for (const name of await readdir(at(root, project.name)).catch(() => [] as string[])) {
      const id = name.slice(0, -".jsonl".length);
      if (name.endsWith(".jsonl") && UUID.test(id)) found.set(id, at(root, project.name, name));
    }
  }
  return found;
}

// ---- The record of names and copies.

async function readLedger(): Promise<Ledger> {
  const json = await readJson(LEDGER);
  return {
    names: (json?.names as Ledger["names"]) ?? {},
    known: (json?.known as Ledger["known"]) ?? {},
    operations: Array.isArray(json?.operations) ? (json.operations as LedgerOperation[]) : [],
  };
}

async function writeLedger(ledger: Ledger): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  // Operations beyond the last few can no longer be undone: their kept files go.
  for (const old of ledger.operations.splice(MAX_OPERATIONS)) await rm(at(BACKUPS, old.id), { recursive: true, force: true });
  await writeAtomic(LEDGER, JSON.stringify(ledger));
}

/** Learns which email and organization each account id is, as the Claude app and the CLI name them; returns whether anything was new. */
async function learn(ledger: Ledger): Promise<boolean> {
  const before = JSON.stringify(ledger.known);
  const account = (await readJson(livePlace("claude").claudeConfig))?.oauthAccount as Json | undefined;
  const uuid = text(account?.accountUuid);
  if (uuid && UUID.test(uuid)) {
    ledger.known[uuid] = {
      email: text(account?.emailAddress) ?? ledger.known[uuid]?.email,
      org: text(account?.organizationUuid) ?? ledger.known[uuid]?.org,
      orgName: text(account?.organizationName) ?? ledger.known[uuid]?.orgName,
    };
  }
  for (const saved of await savedClaudeAccounts().catch(() => [])) {
    const known = ledger.known[saved.accountUuid] ?? {};
    ledger.known[saved.accountUuid] = { ...known, email: known.email ?? saved.label, org: known.org ?? saved.organizationUuid };
  }
  return JSON.stringify(ledger.known) !== before;
}

// ---- Reading the app's chats.

async function readChats(dir: string): Promise<RawChat[]> {
  const chats: RawChat[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!CHAT_FILE.test(name)) continue;
    const file = at(dir, name);
    try {
      const info = await stat(file);
      if (info.size > MAX_CHAT_BYTES) continue;
      const json = await readJson(file);
      if (json) chats.push({ id: name.slice(0, -".json".length), file, json, modified: info.mtimeMs });
    } catch {
      /* removed meanwhile */
    }
  }
  return chats;
}

const chatTitle = (json: Json) => text(json.title)?.trim() || "Untitled chat";

/** The organization where an account's new chats go: the one the app last used it with, else the one with its chats. */
function homeOrg(account: string, lists: { org: string; raw: RawChat[] }[], ledger: Ledger): string | null {
  const learned = ledger.known[account]?.org;
  if (learned && lists.some((l) => l.org === learned)) return learned;
  const withChats = lists.filter((l) => l.raw.length > 0).sort((a, b) => b.raw.length - a.raw.length);
  if (withChats.length > 0) return withChats[0].org;
  return lists.length === 1 ? lists[0].org : null;
}

/**
 * The permission mode of the Claude app's chat that continues Claude Code
 * conversation `id` (its cliSessionId), as the app notes it for the chat:
 * "default", "acceptEdits", "plan", "auto", "bypassPermissions"...; null when
 * no chat there continues it, or it notes none.
 */
export async function appChatMode(id: string): Promise<string | null> {
  const dir = await appDir();
  if (!dir) return null;
  const root = at(dir, "claude-code-sessions");
  for (const account of await subdirs(root)) {
    for (const org of await subdirs(at(root, account))) {
      const chat = (await readChats(at(root, account, org))).find((c) => c.json.cliSessionId === id);
      if (chat) return text(chat.json.permissionMode);
    }
  }
  return null;
}

type Snapshot = { dir: string | null; root: string; running: boolean; ledger: Ledger; places: RawPlace[] };

async function snapshot(): Promise<Snapshot> {
  const ledger = await readLedger();
  const dir = await appDir();
  if (!dir) return { dir: null, root: "", running: false, ledger, places: [] };
  if (await learn(ledger)) await writeLedger(ledger);
  const root = at(dir, "claude-code-sessions");
  const current = text((await readJson(at(dir, "config.json")))?.lastKnownAccountUuid);
  const running = await appRunning(dir);
  const index = await conversations();
  const logs = new Map<string, { size: number; modified: number } | null>();
  const now = Date.now();
  const places: RawPlace[] = [];

  for (const account of await subdirs(root)) {
    const lists = await Promise.all((await subdirs(at(root, account))).map(async (org) => ({ org, raw: await readChats(at(root, account, org)) })));
    const home = homeOrg(account, lists, ledger);
    const known = ledger.known[account] ?? {};
    for (const { org, raw } of lists) {
      // The app keeps empty folders for organizations it only glanced at; only the ones with chats, and where new ones go, matter.
      if (raw.length === 0 && org !== home) continue;
      const chats: ClaudeAppChat[] = [];
      for (const { id, json, modified } of raw) {
        const cli = text(json.cliSessionId);
        const file = cli ? index.get(cli) : undefined;
        if (file && !logs.has(file)) logs.set(file, await stat(file).then((s) => ({ size: s.size, modified: s.mtimeMs }), () => null));
        const log = file ? logs.get(file) : null;
        const lastActivityAt = time(json.lastActivityAt);
        chats.push({
          id,
          title: chatTitle(json),
          cwd: text(json.cwd) ?? "",
          createdAt: time(json.createdAt),
          lastActivityAt,
          archived: json.isArchived === true,
          model: text(json.model),
          turns: typeof json.completedTurns === "number" ? json.completedTurns : null,
          bytes: log?.size ?? null,
          inUse: running && account === current && now - Math.max(lastActivityAt, modified, log?.modified ?? 0) < IN_USE_MS,
          copiedTo: [],
          copiedFrom: null,
        });
      }
      chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      places.push({
        account,
        org,
        label: ledger.names[account] ?? known.email ?? null,
        email: known.email ?? null,
        orgName: known.org === org ? (known.orgName ?? null) : null,
        current: account === current,
        home: org === home,
        chats,
        dir: at(root, account, org),
        raw,
      });
    }
  }

  // Where each chat's copies are, from the record of what was copied, as long as they are still there (Undo keeps copies worked in since).
  const present = new Set(places.flatMap((p) => p.chats.map((c) => `${p.account}/${p.org}/${c.id}`)));
  for (const op of ledger.operations) {
    for (const item of op.items) {
      if (!present.has(`${op.to.account}/${op.to.org}/${item.copy}`)) continue;
      const source = places.find((p) => p.account === op.from.account && p.org === op.from.org)?.chats.find((c) => c.id === item.source);
      if (source && !source.copiedTo.some((t) => t.account === op.to.account && t.org === op.to.org)) source.copiedTo.push(op.to);
      const copy = places.find((p) => p.account === op.to.account && p.org === op.to.org)?.chats.find((c) => c.id === item.copy);
      if (copy) copy.copiedFrom = op.from;
    }
  }
  return { dir, root, running, ledger, places };
}

export function claudeAppState(): Promise<ClaudeAppState> {
  return serialize(async () => stateOf(await snapshot()));
}

function stateOf(s: Snapshot): ClaudeAppState {
  const places: ClaudeAppPlace[] = s.places.map((p) => ({
    account: p.account,
    org: p.org,
    label: p.label,
    email: p.email,
    orgName: p.orgName,
    current: p.current,
    home: p.home,
    chats: p.chats,
  }));
  const history: ChatOperation[] = s.ledger.operations.slice(0, 10).map((op) => ({
    ...op,
    items: op.items.map(({ title, source, copy }) => ({ title, source, copy })),
  }));
  return { found: s.dir !== null, running: s.running, places, history };
}

// ---- Copying.

/** Every id replaced by its new one, wherever it appears: a copy points at its own conversation and folders throughout. */
function renameIds(content: string, renames: Map<string, string>): string {
  let out = content;
  for (const [old, next] of renames) out = out.replaceAll(old, next);
  return out;
}

/** A folder of a conversation (subagents, tool output), with the ids renamed inside its logs. */
async function copyTree(from: string, to: string, renames: Map<string, string>): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = at(from, entry.name);
    const target = at(to, renameIds(entry.name, renames));
    if (entry.isDirectory()) await copyTree(source, target, renames);
    else if (/\.(jsonl|json)$/i.test(entry.name)) await writeFile(target, renameIds(await readFile(source, "utf8"), renames), { flag: "wx" });
    else await copyFile(source, target);
  }
}

/**
 * One Claude Code conversation under its new id: its log, its folder and its
 * edit history. Every path written is added to `created`; returns the size of
 * the log.
 */
async function copyConversation(old: string, renames: Map<string, string>, index: Map<string, string>, created: string[]): Promise<number> {
  const file = index.get(old)!;
  const next = renames.get(old)!;
  const project = path.dirname(file);
  const log = at(project, `${next}.jsonl`);
  const content = renameIds(await readFile(file, "utf8"), renames);
  const { atime, mtime } = await stat(file);
  created.push(log);
  await writeFile(log, content, { flag: "wx" });
  await utimes(log, atime, mtime);
  if (await isDir(at(project, old))) {
    created.push(at(project, next));
    await copyTree(at(project, old), at(project, next), renames);
  }
  const history = at(claudeHome(), "file-history", old);
  if (await isDir(history)) {
    const target = at(claudeHome(), "file-history", next);
    created.push(target);
    await cp(history, target, { recursive: true, errorOnExist: true, force: false });
  }
  return Buffer.byteLength(content);
}

/** Removes a conversation this app created: its log, folder and edit history. */
async function removeConversation(id: string, index: Map<string, string>): Promise<void> {
  const file = index.get(id);
  if (file) {
    await rm(file, { force: true });
    await rm(at(path.dirname(file), id), { recursive: true, force: true });
  }
  await rm(at(claudeHome(), "file-history", id), { recursive: true, force: true });
}

async function copyChat(chat: RawChat, targetDir: string, index: Map<string, string>, backupDir: string | null): Promise<Omit<LedgerItem, "title">> {
  const cli = text(chat.json.cliSessionId);
  if (!cli || !UUID.test(cli) || !index.has(cli)) throw new Error("its conversation is not on this computer");
  // Earlier parts of a long conversation, where the app keeps them apart, go along.
  const priors = (Array.isArray(chat.json.priorCliSessionIds) ? chat.json.priorCliSessionIds : []).filter(
    (p): p is string => typeof p === "string" && UUID.test(p) && index.has(p),
  );
  const renames = new Map<string, string>([[chat.id, `local_${randomUUID()}`]]);
  for (const id of [cli, ...priors]) renames.set(id, randomUUID());
  const copyId = renames.get(chat.id)!;
  const created: string[] = [];
  try {
    const bytes = await copyConversation(cli, renames, index, created);
    for (const id of priors) await copyConversation(id, renames, index, created);
    const copy = JSON.parse(renameIds(JSON.stringify(chat.json), renames)) as Json;
    if ("remoteMcpServersConfig" in copy) copy.remoteMcpServersConfig = [];
    for (const key of ACCOUNT_BOUND) delete copy[key];
    const target = at(targetDir, `${copyId}.json`);
    created.push(target);
    await writeAtomic(target, JSON.stringify(copy), chat.modified);
    let backup: string | undefined;
    if (backupDir) {
      backup = at(backupDir, path.basename(chat.file));
      await cp(chat.file, backup, { preserveTimestamps: true });
      await rm(chat.file);
    }
    return { source: chat.id, copy: copyId, clis: [cli, ...priors].map((id) => renames.get(id)!), activity: time(chat.json.lastActivityAt), bytes, backup };
  } catch (err) {
    await Promise.all(created.map((p) => rm(p, { recursive: true, force: true })));
    throw err;
  }
}

/** Copies (or moves) chats to another account's list in the Claude app. */
export function copyChats(from: ChatPlace, to: ChatPlace, ids: string[], move: boolean): Promise<ChatsResult> {
  return serialize(async () => {
    const s = await snapshot();
    if (!s.dir) throw new Error("The Claude app's data was not found on this computer.");
    const source = s.places.find((p) => p.account === from.account && p.org === from.org);
    const target = s.places.find((p) => p.account === to.account && p.org === to.org);
    if (!source || !target) throw new Error("That account is no longer in the Claude app's folders. Refresh and try again.");
    if (source === target) throw new Error("Pick another account to copy to.");
    const index = await conversations();
    const op: LedgerOperation = { id: randomUUID(), kind: move ? "move" : "copy", at: Date.now(), from, to, items: [], undone: null };
    const skipped: ChatsResult["skipped"] = [];
    for (const id of [...new Set(ids)]) {
      const chat = source.raw.find((c) => c.id === id);
      if (!chat) {
        skipped.push({ title: id, reason: "it is no longer there" });
        continue;
      }
      const title = chatTitle(chat.json);
      if (move && source.chats.find((c) => c.id === id)?.inUse) {
        skipped.push({ title, reason: "it is open in the Claude app: copy it, or move it once the app is closed" });
        continue;
      }
      try {
        const item = await copyChat(chat, target.dir, index, move ? at(BACKUPS, op.id) : null);
        op.items.push({ title, ...item });
      } catch (err) {
        skipped.push({ title, reason: message(err) });
      }
    }
    if (op.items.length > 0) {
      s.ledger.operations.unshift(op);
      await writeLedger(s.ledger);
    }
    return { done: op.items.length, skipped, operation: op.items.length > 0 ? op.id : null };
  });
}

/** Whether a copy was worked in since it was made: the app dated newer activity, carried on in a new conversation, or wrote to its log. */
async function usedSince(copy: Json, item: LedgerItem, index: Map<string, string>): Promise<boolean> {
  if (time(copy.lastActivityAt) > item.activity || text(copy.cliSessionId) !== item.clis[0]) return true;
  if (item.bytes === undefined) return false;
  const log = index.get(item.clis[0]);
  return (log ? await stat(log).then((s) => s.size, () => -1) : -1) !== item.bytes;
}

/**
 * Undoes a copy or a move: the copies go, with their conversations, unless
 * they were worked in since, and moved chats come back where they were.
 */
export function undoChats(operationId: string): Promise<ChatsResult> {
  return serialize(async () => {
    const s = await snapshot();
    const op = s.ledger.operations.find((o) => o.id === operationId);
    if (!s.dir || !op || op.undone) throw new Error("That can no longer be undone.");
    const index = await conversations();
    let done = 0;
    let kept = 0;
    for (const item of op.items) {
      const file = at(s.root, op.to.account, op.to.org, `${item.copy}.json`);
      const copy = await readJson(file);
      if (copy && (await usedSince(copy, item, index))) kept++;
      else {
        await rm(file, { force: true });
        for (const id of item.clis) await removeConversation(id, index);
        done++;
      }
      if (item.backup && (await exists(item.backup))) {
        const back = at(s.root, op.from.account, op.from.org, path.basename(item.backup));
        if (!(await exists(back))) await cp(item.backup, back, { preserveTimestamps: true });
      }
    }
    op.undone = { at: Date.now(), kept };
    await writeLedger(s.ledger);
    return { done, skipped: [], operation: op.id, kept };
  });
}

/** A name for an account the app does not say the email of; null forgets it. */
export function nameAccount(account: string, name: string | null): Promise<void> {
  return serialize(async () => {
    if (!UUID.test(account)) throw new Error("That is not an account id.");
    const ledger = await readLedger();
    const clean = name?.trim().slice(0, 60);
    if (clean) ledger.names[account] = clean;
    else delete ledger.names[account];
    await writeLedger(ledger);
  });
}

/** A place as the API receives it: an account id and an organization id. */
export const isPlace = (v: unknown): v is ChatPlace =>
  Boolean(v && typeof v === "object" && UUID.test(String((v as ChatPlace).account)) && UUID.test(String((v as ChatPlace).org)));

export const isChatId = (v: unknown): v is string => typeof v === "string" && CHAT_FILE.test(`${v}.json`);

export const isOperationId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const isAccountId = isOperationId;
