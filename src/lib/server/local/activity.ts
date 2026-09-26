import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  countQuarters,
  dayKey,
  lastDays,
  NO_QUARTERS,
  orQuarters,
  quarterOf,
  withQuarter,
  type DeviceActivity,
  type ModelUsage,
  type ProjectActivity,
  type Quarters,
  type SessionActivity,
  type SessionWork,
  type Tool,
  type TokenRow,
  type WorkRow,
} from "@/lib/activity";
import { DATA_DIR } from "@/lib/server/data-dir";
import { livePlace } from "./cli";
import { sentMessage } from "./inbox";

/*
 * What this computer's Claude Code and Codex CLIs worked on, from the session
 * logs they keep: Claude Code's under ~/.claude/projects, Codex's under
 * ~/.codex/sessions. Per session: where it started and from what, when, the
 * git branch, the models and their token counts, its subagents (Codex's
 * sub-agent threads fold into the session that started them), and its title
 * (Claude Code's custom title or summary, Codex's thread name) or else its
 * first prompt (reported only from a computer that shares session content).
 * Per day, how many prompts were typed, files changed (and lines added and
 * removed, from the diffs the CLIs log) and commands run, and in which quarter
 * hours anything happened. The rest of what sessions say is skipped over here;
 * transcript.ts reads it on request.
 *
 * Logs run to gigabytes, so each file's summary is cached with its size and
 * modification time, and only files that changed are read again.
 */

const DAYS = 30;
const CACHE_FILE = path.join(DATA_DIR, "activity-cache.json");
const CACHE_VERSION = 6;
/** Sessions reported, most recently active first. */
const MAX_SESSIONS = 300;
/** A title or first prompt is cut to this. */
const TITLE_MAX = 160;
/** How far into a log to look for how its session started, and for its first prompt. */
const HEAD_LINES = 60;
const PROMPT_LINES = 400;

/** input, output, cache writes, of which kept an hour, cache reads, replies */
type Counts = [number, number, number, number, number, number];

/** prompts, files changed, lines added, lines removed, commands, and the quarter hours with activity: a WorkRow's */
type Work = [number, number, number, number, number, Quarters];
type WorkCounts = Partial<Pick<WorkRow, "prompts" | "edits" | "added" | "removed" | "commands">>;

/** What a log used, with rows keyed by `day \t model`, and what it did, by day. */
type Tally = { rows: Record<string, Counts>; work: Record<string, Work> };

/**
 * One log file: the folder its session started in (the CLIs also record where
 * each step ran, which wanders into subfolders), its session (a Claude Code
 * subagent's log carries its parent's; a Codex sub-agent's thread names the
 * thread that started it as `parent`), and its tally.
 *
 * A Claude Code conversation can be in several logs: resuming or forking a
 * session, or copying a chat to another account, writes what was said so far
 * into a new log. Those logs share their first reply (`head`), and what the
 * new log copied was written before it existed (`copied`): that counts only
 * in the log it came from.
 */
type FileSummary = Tally & {
  cwd: string | null;
  session: string | null;
  parent: string | null;
  source: string | null;
  branch: string | null;
  /** The model of its latest reply. */
  model: string | null;
  startedAt: number;
  lastActive: number;
  title: string | null;
  prompt: string | null;
  /** Its first reply, as message and request id. */
  head: string | null;
  /** What it had from before it existed; null when nothing. */
  copied: Tally | null;
};
type Cache = { version: number; files: Record<string, { tool: Tool; size: number; mtimeMs: number; bornMs: number; summary: FileSummary }> };

/** A log's steps this much older than the log itself came from somewhere else; the first ones are written as the log is made. */
const COPIED_MS = 5 * 60_000;

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const clip = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s).replace(/\s+/g, " ").trim();

const emptySummary = (): FileSummary => ({
  cwd: null,
  session: null,
  parent: null,
  source: null,
  branch: null,
  model: null,
  startedAt: 0,
  lastActive: 0,
  title: null,
  prompt: null,
  head: null,
  rows: {},
  work: {},
  copied: null,
});

/** Something happened at `at`: its quarter hour had activity, and `counts` add to its day. */
function did(tally: Tally, at: number, counts: WorkCounts = {}): void {
  const w = (tally.work[dayKey(at)] ??= [0, 0, 0, 0, 0, NO_QUARTERS]);
  w[0] += counts.prompts ?? 0;
  w[1] += counts.edits ?? 0;
  w[2] += counts.added ?? 0;
  w[3] += counts.removed ?? 0;
  w[4] += counts.commands ?? 0;
  w[5] = withQuarter(w[5], quarterOf(at));
}

/** A model reply at `at`, counted in `tally`. */
function add(summary: FileSummary, tally: Tally, at: number, branch: unknown, model: string, counts: Counts): void {
  if (at >= summary.lastActive) {
    summary.lastActive = at;
    summary.model = model;
    if (typeof branch === "string" && branch) summary.branch = branch;
  }
  if (!summary.startedAt || at < summary.startedAt) summary.startedAt = at;
  const key = `${dayKey(at)}\t${model}`;
  const row = (tally.rows[key] ??= [0, 0, 0, 0, 0, 0]);
  counts.forEach((n, i) => (row[i] += n));
  did(tally, at);
}

/** How many lines a file's content has. */
const lineCount = (content: string) => (content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0);

/** The lines a unified diff adds and removes; file headers before its first hunk are not lines. */
function diffLines(diff: string): [number, number] {
  let added = 0;
  let removed = 0;
  let hunks = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) hunks = true;
    else if (!hunks && (line.startsWith("+++") || line.startsWith("---"))) continue;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return [added, removed];
}

/** Where what someone typed counts as a prompt: not the CLI's own context, nor its note that a reply was stopped. */
const typed = (prompt: string) => !/^\s*(<|\[Request interrupted)/.test(prompt);

function lines(file: string): readline.Interface {
  return readline.createInterface({ input: createReadStream(/* turbopackIgnore: true */ file), crlfDelay: Infinity });
}

export function parse(line: string): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(line);
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A Claude Code entry's message as text: all of it, or its text blocks joined. */
export function claudeText(entry: Record<string, unknown>): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * What someone typed, from a Claude Code user entry: not a tool result, a
 * command or the CLI's own reminders. A message AI Cooldown put into a session
 * open on the computer (see inbox.ts) counts, as what was typed on the website.
 */
export function claudePrompt(entry: Record<string, unknown>): string | null {
  if (entry.isSidechain) return null;
  const typed = claudeText(entry);
  const sent = sentMessage(typed);
  if (sent !== null) return sent.trim() ? sent : null;
  if (entry.isMeta) return null;
  return typed.trim() && !typed.trimStart().startsWith("<") ? typed : null;
}

/** What someone asked Codex: an IDE extension wraps the request in context, which is left out. */
export function codexPrompt(message: string): string {
  const request = /## My request for Codex:\s*([\s\S]*)$/.exec(message);
  return (request ? request[1] : message).trim();
}

/** Claude Code's tools that run shell commands. */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);

/** The lines a Claude Code edit added and removed: its patch's hunks, or a new file's content. */
function editLines(result: { type?: unknown; content?: unknown; structuredPatch: unknown[] }): [number, number] {
  if (result.type === "create" && typeof result.content === "string") return [lineCount(result.content), 0];
  let added = 0;
  let removed = 0;
  for (const hunk of result.structuredPatch) {
    const hunkLines = (hunk as { lines?: unknown } | null)?.lines;
    for (const line of Array.isArray(hunkLines) ? hunkLines : []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return [added, removed];
}

/**
 * A Claude Code transcript: every model reply carries its usage. A reply is
 * written once per content block with the same usage, so each counts once.
 * What someone typed is a prompt; an edit's result carries the patch it
 * applied; a shell command is a tool call. What is older than the log (`born`,
 * its creation time) was copied into it.
 */
async function summarizeClaude(file: string, born: number): Promise<FileSummary> {
  const summary = emptySummary();
  const seen = new Set<string>();
  const commands = new Set<string>();
  const from = born > 0 ? born - COPIED_MS : -Infinity;
  const tally = (at: number): Tally => (at < from ? (summary.copied ??= { rows: {}, work: {} }) : summary);
  let n = 0;
  for await (const line of lines(file)) {
    n += 1;
    if (n <= HEAD_LINES && (summary.cwd === null || summary.session === null || summary.source === null) && line.includes('"sessionId"')) {
      const head = parse(line);
      summary.cwd ??= text(head?.cwd);
      summary.session ??= text(head?.sessionId);
      summary.source ??= text(head?.entrypoint);
    }
    if (line.includes('"custom-title"') || line.includes('"type":"summary"')) {
      const named = parse(line);
      const title = text(named?.customTitle) ?? (named?.type === "summary" ? text(named.summary) : null);
      if (title) summary.title = clip(title);
      continue;
    }
    // Tool output is skipped without parsing it, but for an edit's, which says what it changed.
    const patched = line.includes('"structuredPatch"');
    if (line.includes('"type":"user"') && (patched || !line.includes('"tool_result"'))) {
      const entry = parse(line);
      if (entry?.type === "user") {
        const at = Date.parse(String(entry.timestamp));
        const result = entry.toolUseResult as { type?: unknown; content?: unknown; structuredPatch?: unknown } | undefined;
        if (patched && result && Array.isArray(result.structuredPatch)) {
          const [added, removed] = editLines({ ...result, structuredPatch: result.structuredPatch });
          if (!Number.isNaN(at)) did(tally(at), at, { edits: 1, added, removed });
        } else {
          const prompt = entry.isCompactSummary ? null : claudePrompt(entry);
          if (prompt && typed(prompt)) {
            if (summary.prompt === null && n <= PROMPT_LINES) summary.prompt = clip(prompt);
            if (!Number.isNaN(at)) did(tally(at), at, { prompts: 1 });
          }
        }
        continue;
      }
    }
    if (!line.includes('"usage"')) continue; // skips the rest of what was said without parsing it
    const entry = parse(line);
    const message = entry?.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown>; content?: unknown } | undefined;
    if (entry?.type !== "assistant" || !message?.usage) continue;
    const at = Date.parse(String(entry.timestamp));
    if (Number.isNaN(at)) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const b = block as { type?: unknown; id?: unknown; name?: unknown } | null;
      if (b?.type !== "tool_use" || typeof b.id !== "string" || !COMMAND_TOOLS.has(String(b.name)) || commands.has(b.id)) continue;
      commands.add(b.id);
      did(tally(at), at, { commands: 1 });
    }
    const model = typeof message.model === "string" ? message.model : "unknown";
    if (model === "<synthetic>") continue; // the CLI's own placeholder replies, never billed
    const key = message.id && entry.requestId ? `${message.id}:${entry.requestId}` : String(entry.uuid);
    if (seen.has(key)) continue;
    seen.add(key);
    summary.head ??= key;
    const u = message.usage;
    const cacheWrite = count(u.cache_creation_input_tokens);
    const hour = count((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
    add(summary, tally(at), at, entry.gitBranch, model, [count(u.input_tokens), count(u.output_tokens), cacheWrite, Math.min(hour, cacheWrite), count(u.cache_read_input_tokens), 1]);
  }
  return summary;
}

type CodexUsage = { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number };

/** Codex's tools that run shell commands, as its raw tool calls name them. */
const SHELL_CALLS = new Set(["shell", "shell_command", "container.exec", "exec_command", "local_shell"]);

/** What an apply_patch patch changes: a file per "*** Add/Update/Delete File:" header, and the lines its hunks add and remove. */
function patchWork(patch: string): WorkCounts {
  const counts = { edits: 0, added: 0, removed: 0 };
  for (const line of patch.split("\n")) {
    if (/^\*\*\* (Add|Update|Delete) File: /.test(line)) counts.edits += 1;
    else if (line.startsWith("+")) counts.added += 1;
    else if (line.startsWith("-")) counts.removed += 1;
  }
  return counts;
}

/** What a FileChange item changed: a file per change, with the lines its diff adds and removes, or all of a new or deleted file's. */
function fileChangeWork(changes: unknown): WorkCounts {
  const counts = { edits: 0, added: 0, removed: 0 };
  const list: unknown[] = Array.isArray(changes) ? changes : changes && typeof changes === "object" ? Object.values(changes) : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const change = raw as { type?: unknown; unified_diff?: unknown; content?: unknown };
    counts.edits += 1;
    if (typeof change.unified_diff === "string") {
      const [added, removed] = diffLines(change.unified_diff);
      counts.added += added;
      counts.removed += removed;
    } else if (typeof change.content === "string") {
      if (change.type === "delete") counts.removed += lineCount(change.content);
      else counts.added += lineCount(change.content);
    }
  }
  return counts;
}

/** What a raw tool call did: applied a patch, ran a command, or neither. */
function callWork(payload: Record<string, unknown>): WorkCounts | null {
  if (payload.type === "custom_tool_call") return payload.name === "apply_patch" && typeof payload.input === "string" ? patchWork(payload.input) : null;
  const args = payload.type === "local_shell_call" ? (payload.action as Record<string, unknown> | undefined) : parse(String(payload.arguments ?? ""));
  if (payload.name === "apply_patch") return typeof args?.input === "string" ? patchWork(args.input) : null;
  if (payload.type !== "local_shell_call" && !SHELL_CALLS.has(String(payload.name))) return null;
  const command = Array.isArray(args?.command) ? args.command.join(" ") : typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : "";
  // apply_patch run as a command edits files.
  return command.includes("*** Begin Patch") ? patchWork(command) : { commands: 1 };
}

/**
 * A Codex session: token_count events carry the session's running total, so
 * each request is the difference from the one before (which also makes
 * repeated events count once). Codex counts cached input, and cache writes,
 * inside input. Newer versions log each step as an item (what was typed, a
 * command, a file change); older ones only the raw messages and tool calls,
 * which newer ones log as well, so those count only in a log without items.
 * A log in which Codex never ran a turn holds history it brought over from
 * elsewhere, stamped when it did: nothing in it was done then.
 */
async function summarizeCodex(file: string): Promise<FileSummary> {
  const summary = emptySummary();
  let model = "codex";
  let previous: CodexUsage | null = null;
  let turns = false;
  let items = false;
  /** What the raw entries did, for a log that turns out to have no items. */
  const raw: [number, WorkCounts][] = [];
  /** Whether what was said at `at` is a prompt someone typed; the first is the session's title unless it has one. */
  const prompted = (said: string, at: number): boolean => {
    const prompt = codexPrompt(said);
    if (!prompt || !typed(prompt)) return false;
    summary.prompt ??= clip(prompt);
    return !Number.isNaN(at);
  };
  for await (const line of lines(file)) {
    if (!items && line.includes('"item_completed"')) items = true;
    const said = line.includes('"UserMessage"') || line.includes('"user_message"');
    const step = line.includes('"CommandExecution"') || line.includes('"FileChange"');
    const call = !items && (line.includes('"function_call"') || line.includes('"custom_tool_call"') || line.includes('"local_shell_call"'));
    if (!said && !step && !call && !line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    const entry = parse(line);
    const payload = entry?.payload as Record<string, unknown> | undefined;
    if (!entry || !payload) continue;
    const at = Date.parse(String(entry.timestamp));
    if (payload.type === "item_completed") {
      const item = payload.item as { type?: unknown; status?: unknown; content?: { text?: unknown }[]; changes?: unknown } | undefined;
      if (item?.type === "UserMessage" && prompted((item.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n"), at)) did(summary, at, { prompts: 1 });
      else if (Number.isNaN(at)) continue;
      else if (item?.type === "CommandExecution") did(summary, at, { commands: 1 });
      else if (item?.type === "FileChange" && item.status !== "failed" && item.status !== "declined") did(summary, at, fileChangeWork(item.changes));
      continue;
    }
    if (payload.type === "user_message") {
      if (prompted(String(payload.message ?? ""), at)) raw.push([at, { prompts: 1 }]);
      continue;
    }
    if (call && entry.type === "response_item") {
      const work = Number.isNaN(at) ? null : callWork(payload);
      if (work) raw.push([at, work]);
      continue;
    }
    if (entry.type === "session_meta") {
      summary.cwd = text(payload.cwd);
      summary.session = text(payload.id) ?? text(payload.session_id);
      summary.source = text(payload.originator) ?? text(payload.source);
      // A sub-agent's thread: its source is { subagent: ... }, and a spawned one names the thread that started it.
      const sub = (payload.source as { subagent?: unknown } | null | undefined)?.subagent;
      const spawn = sub && typeof sub === "object" ? (sub as { thread_spawn?: { parent_thread_id?: unknown } }).thread_spawn : undefined;
      summary.parent = text(payload.parent_thread_id) ?? text(spawn?.parent_thread_id);
      summary.branch = text((payload.git as { branch?: unknown } | undefined)?.branch);
      const started = Date.parse(String(payload.timestamp ?? entry.timestamp));
      if (!Number.isNaN(started)) summary.startedAt = started;
    } else if (entry.type === "turn_context") {
      turns = true;
      if (typeof payload.model === "string") model = payload.model;
      summary.cwd ??= text(payload.cwd);
    } else if (payload.type === "token_count") {
      const total = (payload.info as { total_token_usage?: CodexUsage } | null | undefined)?.total_token_usage;
      if (!total) continue;
      const diff = (k: keyof CodexUsage) => count(total[k]) - count(previous?.[k]);
      const keys: (keyof CodexUsage)[] = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];
      // A total that went down started over (a new context): all of it is new.
      const delta = keys.some((k) => diff(k) < 0) ? Object.fromEntries(keys.map((k) => [k, count(total[k])])) : Object.fromEntries(keys.map((k) => [k, diff(k)]));
      previous = total;
      if (keys.every((k) => delta[k] === 0) || Number.isNaN(at)) continue;
      const cached = Math.min(delta.cached_input_tokens, delta.input_tokens);
      const written = Math.min(delta.cache_write_input_tokens, delta.input_tokens - cached);
      add(summary, summary, at, summary.branch, model, [delta.input_tokens - cached - written, delta.output_tokens, written, 0, cached, 1]);
    }
  }
  if (!turns) summary.work = {};
  else if (!items) for (const [at, counts] of raw) did(summary, at, counts);
  return summary;
}

/** The .jsonl files under dir, recursively, modified since `since`. */
async function logsUnder(dir: string, since: number, depth = 0): Promise<string[]> {
  const entries = await readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
    if (entry.isDirectory() && depth < 6) out.push(...(await logsUnder(full, since, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs >= since) out.push(full);
    }
  }
  return out;
}

/**
 * Codex's thread names, the titles its app and `codex resume` show (named by
 * hand or for you), by thread id. The index only grows: a thread's last entry
 * is its name now.
 */
async function codexThreadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const index = await readFile(path.join(/* turbopackIgnore: true */ livePlace("codex").dir, "session_index.jsonl"), "utf8").catch(() => "");
  for (const line of index.split("\n")) {
    const entry = parse(line);
    const id = text(entry?.id);
    const name = text(entry?.thread_name);
    if (id && name) names.set(id, clip(name));
  }
  return names;
}

/**
 * The model a Codex thread ran its latest turn on, from its log, looking only
 * at logs written since `since`: what a remote Codex session used when it
 * asked for none.
 */
export async function codexModel(threadId: string, since: number): Promise<string | null> {
  const dir = path.join(/* turbopackIgnore: true */ livePlace("codex").dir, "sessions");
  const file = (await logsUnder(dir, since)).find((f) => f.endsWith(`${threadId}.jsonl`));
  let model: string | null = null;
  if (file) {
    for await (const line of lines(file)) {
      if (!line.includes('"turn_context"')) continue;
      const payload = parse(line)?.payload as { model?: unknown } | undefined;
      if (typeof payload?.model === "string") model = payload.model;
    }
  }
  return model;
}

async function loadCache(): Promise<Cache> {
  try {
    const cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
    if (cache.version === CACHE_VERSION && cache.files) return cache;
  } catch {
    /* none yet, or unreadable: start over */
  }
  return { version: CACHE_VERSION, files: {} };
}

async function saveCache(cache: Cache): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache));
  await rename(tmp, CACHE_FILE);
}

/** A folder as the team sees it: the home folder as ~, forward slashes. Nobody else needs the user name in the path. */
function displayPath(cwd: string): string {
  const rel = path.relative(os.homedir(), cwd);
  const shown = rel === "" ? "~" : !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : path.normalize(cwd);
  return shown.replaceAll("\\", "/");
}

const rowsOf = (counts: Iterable<[string, Counts]>) =>
  [...counts].map(([key, [input, output, cacheWrite, cacheWrite1h, cacheRead, messages]]) => {
    const [day, model] = key.split("\t");
    return { day, model, input, output, cacheWrite, cacheWrite1h, cacheRead, messages };
  });

function addCounts(into: Map<string, Counts>, key: string, counts: Counts): void {
  const row = into.get(key) ?? ([0, 0, 0, 0, 0, 0] as Counts);
  counts.forEach((n, i) => (row[i] += n));
  into.set(key, row);
}

/** A log's work on `day` added to what is there. The task a session hands a subagent (`own` false) is not a prompt anyone typed. */
function addWork(into: Map<string, Work>, day: string, [prompts, edits, added, removed, commands, quarters]: Work, own: boolean): void {
  const w = into.get(day) ?? [0, 0, 0, 0, 0, NO_QUARTERS];
  into.set(day, [w[0] + (own ? prompts : 0), w[1] + edits, w[2] + added, w[3] + removed, w[4] + commands, orQuarters(w[5], quarters)]);
}

/** A session's work over its days, each quarter hour with any activity counting 15 minutes. */
function sessionWork(days: Map<string, Work>): SessionWork {
  const total: SessionWork = { prompts: 0, edits: 0, added: 0, removed: 0, commands: 0, minutes: 0 };
  for (const [prompts, edits, added, removed, commands, quarters] of days.values()) {
    total.prompts += prompts;
    total.edits += edits;
    total.added += added;
    total.removed += removed;
    total.commands += commands;
    total.minutes += countQuarters(quarters) * 15;
  }
  return total;
}

export type Scan = {
  activity: DeviceActivity;
  /** Each reported project's folder on disk, by the path the team sees: remote sessions run there. */
  folders: Map<string, string>;
  /** Each session's own log (not its subagents'), by `tool:id`: what a transcript is read from. */
  logs: Map<string, string>;
};

/** This computer's activity over the last 30 days. Session titles are in it: leave them out unless the computer shares session content. */
export async function scanActivity(): Promise<Scan> {
  const now = Date.now();
  const days = lastDays(DAYS, now);
  const since = new Date(`${days[0]}T00:00:00`).getTime();
  const sources: { tool: Tool; dir: string }[] = [
    // The ignore comments keep the build from tracing (and bundling) whatever these could match in the project.
    { tool: "claude", dir: path.join(/* turbopackIgnore: true */ livePlace("claude").dir, "projects") },
    { tool: "codex", dir: path.join(/* turbopackIgnore: true */ livePlace("codex").dir, "sessions") },
  ];

  const cache = await loadCache();
  const next: Cache = { version: CACHE_VERSION, files: {} };
  /**
   * Log files by project. Claude Code keeps each project's sessions, its
   * subagents' included, in one folder under projects/; a Codex session
   * belongs where it started.
   */
  const groups = new Map<string, { tool: Tool; files: { file: string; depth: number; born: number; summary: FileSummary }[] }>();
  for (const { tool, dir } of sources) {
    for (const file of await logsUnder(dir, since)) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      // When the log was made; 0 where the file system does not say.
      const born = info.birthtimeMs > 0 ? info.birthtimeMs : 0;
      const hit = cache.files[file];
      const fresh = hit && hit.tool === tool && hit.size === info.size && hit.mtimeMs === info.mtimeMs && hit.bornMs === born;
      const summary = fresh ? hit.summary : await (tool === "claude" ? summarizeClaude(file, born) : summarizeCodex(file)).catch(emptySummary);
      next.files[file] = { tool, size: info.size, mtimeMs: info.mtimeMs, bornMs: born, summary };
      const parts = path.relative(dir, file).split(path.sep);
      if (tool === "codex" && !summary.cwd) continue;
      const key = tool === "claude" ? `claude\n${parts[0]}` : `codex\n${path.normalize(summary.cwd!)}`;
      const group = groups.get(key) ?? { tool, files: [] };
      group.files.push({ file, depth: parts.length, born, summary });
      groups.set(key, group);
    }
  }
  await saveCache(next).catch(() => undefined);

  const folders = new Map<string, string>();
  const logs = new Map<string, string>();
  const projects: ProjectActivity[] = [];
  type SessionSum = Omit<SessionActivity, "usage" | "work"> & { models: Map<string, Counts>; work: Map<string, Work> };
  const sessions = new Map<string, SessionSum>();
  // A Codex sub-agent's thread counts in the session it was started from, as a Claude Code subagent's log does: the first thread up the chain.
  const parents = new Map<string, string>();
  for (const { tool, files } of groups.values()) {
    if (tool === "codex") for (const { summary } of files) if (summary.session && summary.parent) parents.set(summary.session, summary.parent);
  }
  const rootOf = (id: string) => {
    for (let hops = 0; hops < 10 && parents.has(id); hops++) id = parents.get(id)!;
    return id;
  };
  const names = await codexThreadNames();
  for (const { tool, files } of groups.values()) {
    // Where the project is: where its own sessions started. Subagents' logs sit deeper, and may start in a subfolder.
    const start = files.filter((f) => f.summary.cwd).sort((x, y) => x.depth - y.depth || y.summary.lastActive - x.summary.lastActive)[0];
    if (!start) continue;
    const cwd = start.summary.cwd!;
    const shown = displayPath(cwd);
    let branch: string | null = null;
    let lastActive = 0;
    const rows = new Map<string, Counts>();
    const work = new Map<string, Work>();
    const ids = new Set<string>();
    // Of the logs sharing a first reply, the oldest has what the others copied from it.
    const origin = new Map<string, string>();
    for (const f of [...files].sort((x, y) => x.born - y.born || (x.file < y.file ? -1 : 1))) if (f.summary.head && !origin.has(f.summary.head)) origin.set(f.summary.head, f.file);
    for (const { file, depth, summary } of files) {
      if (summary.lastActive >= lastActive) {
        lastActive = summary.lastActive;
        branch = summary.branch ?? branch;
      }
      const tallies: Tally[] = summary.copied && (!summary.head || origin.get(summary.head) === file) ? [summary, summary.copied] : [summary];
      for (const t of tallies) for (const [key, counts] of Object.entries(t.rows)) addCounts(rows, key, counts);
      const id = summary.session && (tool === "codex" ? rootOf(summary.session) : summary.session);
      // The session's own log, or one of its subagents'.
      const own = !id || (tool === "codex" ? id === summary.session : depth <= 2);
      for (const t of tallies) for (const [day, w] of Object.entries(t.work)) addWork(work, day, w, own);
      if (!id) continue;
      ids.add(id);
      const key = `${tool}:${id}`;
      const s: SessionSum = sessions.get(key) ?? { tool, id, path: shown, title: null, branch: null, source: null, model: null, startedAt: 0, lastActive: 0, subagents: 0, models: new Map(), work: new Map() };
      sessions.set(key, s);
      for (const t of tallies) for (const [day, w] of Object.entries(t.work)) addWork(s.work, day, w, own);
      if (own) {
        logs.set(key, file);
        s.path = shown; // a sub-agent may have started elsewhere: the session is where its own log says
        s.title = (tool === "codex" ? names.get(id) : null) ?? summary.title ?? summary.prompt ?? s.title;
        s.source = summary.source ?? s.source;
        s.model = summary.model ?? s.model; // the conversation's own model: subagents often run a smaller one
      } else s.subagents += 1;
      if (summary.startedAt && (!s.startedAt || summary.startedAt < s.startedAt)) s.startedAt = summary.startedAt;
      if (summary.lastActive >= s.lastActive) {
        s.lastActive = summary.lastActive;
        s.branch = summary.branch ?? s.branch;
      }
      for (const t of tallies) for (const [key2, counts] of Object.entries(t.rows)) addCounts(s.models, key2.split("\t")[1], counts);
    }
    const kept: TokenRow[] = rowsOf(rows)
      .filter((r) => r.day >= days[0])
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1));
    if (kept.length === 0) continue;
    folders.set(shown, cwd);
    const workDays: WorkRow[] = [...work]
      .filter(([day]) => day >= days[0])
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, [prompts, edits, added, removed, commands, quarters]]) => ({ day, prompts, edits, added, removed, commands, quarters }));
    projects.push({ tool, path: shown, name: path.basename(cwd) || shown, branch, lastActive, sessions: ids.size, rows: kept, work: workDays });
  }
  projects.sort((a, b) => b.lastActive - a.lastActive);

  const reported: SessionActivity[] = [...sessions.values()]
    .filter((s) => s.lastActive >= since && folders.has(s.path))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, MAX_SESSIONS)
    .map(({ models, work: byDay, ...s }) => ({
      ...s,
      usage: [...models].map(([model, [input, output, cacheWrite, cacheWrite1h, cacheRead, messages]]): ModelUsage => ({ model, input, output, cacheWrite, cacheWrite1h, cacheRead, messages })),
      work: sessionWork(byDay),
    }));
  return { activity: { scannedAt: now, days: DAYS, projects, sessions: reported }, folders, logs };
}
