import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { dayKey, lastDays, type DeviceActivity, type ModelUsage, type ProjectActivity, type SessionActivity, type Tool, type TokenRow } from "@/lib/activity";
import { DATA_DIR } from "@/lib/server/data-dir";
import { livePlace } from "./cli";

/*
 * What this computer's Claude Code and Codex CLIs worked on, from the session
 * logs they keep: Claude Code's under ~/.claude/projects, Codex's under
 * ~/.codex/sessions. Per session: where it started and from what, when, the
 * git branch, the models and their token counts, its subagents (Codex's
 * sub-agent threads fold into the session that started them), and its title
 * (Claude Code's custom title or summary, Codex's thread name) or else its
 * first prompt (reported only from a computer that shares session content). The
 * rest of what sessions say is skipped over here; transcript.ts reads it on
 * request.
 *
 * Logs run to gigabytes, so each file's summary is cached with its size and
 * modification time, and only files that changed are read again.
 */

const DAYS = 30;
const CACHE_FILE = path.join(DATA_DIR, "activity-cache.json");
const CACHE_VERSION = 4;
/** Sessions reported, most recently active first. */
const MAX_SESSIONS = 300;
/** A title or first prompt is cut to this. */
const TITLE_MAX = 160;
/** How far into a log to look for how its session started, and for its first prompt. */
const HEAD_LINES = 60;
const PROMPT_LINES = 400;

/** input, output, cache writes, of which kept an hour, cache reads, replies */
type Counts = [number, number, number, number, number, number];

/**
 * One log file: the folder its session started in (the CLIs also record where
 * each step ran, which wanders into subfolders), its session (a Claude Code
 * subagent's log carries its parent's; a Codex sub-agent's thread names the
 * thread that started it as `parent`), and what it used, with rows keyed by
 * `day \t model`.
 */
type FileSummary = {
  cwd: string | null;
  session: string | null;
  parent: string | null;
  source: string | null;
  branch: string | null;
  startedAt: number;
  lastActive: number;
  title: string | null;
  prompt: string | null;
  rows: Record<string, Counts>;
};
type Cache = { version: number; files: Record<string, { tool: Tool; size: number; mtimeMs: number; summary: FileSummary }> };

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const clip = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s).replace(/\s+/g, " ").trim();

const emptySummary = (): FileSummary => ({ cwd: null, session: null, parent: null, source: null, branch: null, startedAt: 0, lastActive: 0, title: null, prompt: null, rows: {} });

function add(summary: FileSummary, at: number, branch: unknown, model: string, counts: Counts): void {
  if (at >= summary.lastActive) {
    summary.lastActive = at;
    if (typeof branch === "string" && branch) summary.branch = branch;
  }
  if (!summary.startedAt || at < summary.startedAt) summary.startedAt = at;
  const key = `${dayKey(at)}\t${model}`;
  const row = (summary.rows[key] ??= [0, 0, 0, 0, 0, 0]);
  counts.forEach((n, i) => (row[i] += n));
}

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

/** What someone typed, from a Claude Code user entry: not a tool result, a command or the CLI's own reminders. */
export function claudePrompt(entry: Record<string, unknown>): string | null {
  if (entry.isMeta || entry.isSidechain) return null;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  const typed =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b): b is { type: string; text: string } => Boolean(b) && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
            .map((b) => b.text)
            .join("\n")
        : "";
  return typed.trim() && !typed.trimStart().startsWith("<") ? typed : null;
}

/** What someone asked Codex: an IDE extension wraps the request in context, which is left out. */
export function codexPrompt(message: string): string {
  const request = /## My request for Codex:\s*([\s\S]*)$/.exec(message);
  return (request ? request[1] : message).trim();
}

/**
 * A Claude Code transcript: every model reply carries its usage. A reply is
 * written once per content block with the same usage, so each counts once.
 */
async function summarizeClaude(file: string): Promise<FileSummary> {
  const summary = emptySummary();
  const seen = new Set<string>();
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
    if (summary.prompt === null && n <= PROMPT_LINES && line.includes('"type":"user"') && line.length < 200_000) {
      const entry = parse(line);
      const prompt = entry?.type === "user" ? claudePrompt(entry) : null;
      if (prompt) summary.prompt = clip(prompt);
      continue;
    }
    if (!line.includes('"usage"')) continue; // skips prompts and tool output without parsing them
    const entry = parse(line);
    const message = entry?.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
    if (entry?.type !== "assistant" || !message?.usage) continue;
    const model = typeof message.model === "string" ? message.model : "unknown";
    if (model === "<synthetic>") continue; // the CLI's own placeholder replies, never billed
    const key = message.id && entry.requestId ? `${message.id}:${entry.requestId}` : String(entry.uuid);
    if (seen.has(key)) continue;
    seen.add(key);
    const at = Date.parse(String(entry.timestamp));
    if (Number.isNaN(at)) continue;
    const u = message.usage;
    const cacheWrite = count(u.cache_creation_input_tokens);
    const hour = count((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
    add(summary, at, entry.gitBranch, model, [count(u.input_tokens), count(u.output_tokens), cacheWrite, Math.min(hour, cacheWrite), count(u.cache_read_input_tokens), 1]);
  }
  return summary;
}

type CodexUsage = { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number };

/**
 * A Codex session: token_count events carry the session's running total, so
 * each request is the difference from the one before (which also makes
 * repeated events count once). Codex counts cached input, and cache writes,
 * inside input.
 */
async function summarizeCodex(file: string): Promise<FileSummary> {
  const summary = emptySummary();
  let model = "codex";
  let previous: CodexUsage | null = null;
  for await (const line of lines(file)) {
    if (summary.prompt === null && (line.includes('"UserMessage"') || line.includes('"user_message"'))) {
      const entry = parse(line);
      const payload = entry?.payload as Record<string, unknown> | undefined;
      const item = payload?.item as { type?: unknown; content?: { text?: unknown }[] } | undefined;
      const said = item?.type === "UserMessage" ? (item.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n") : payload?.type === "user_message" ? String(payload.message ?? "") : "";
      if (said.trim()) summary.prompt = clip(codexPrompt(said));
      continue;
    }
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    const entry = parse(line);
    const payload = entry?.payload as Record<string, unknown> | undefined;
    if (!entry || !payload) continue;
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
      if (keys.every((k) => delta[k] === 0)) continue;
      const at = Date.parse(String(entry.timestamp));
      if (Number.isNaN(at)) continue;
      const cached = Math.min(delta.cached_input_tokens, delta.input_tokens);
      const written = Math.min(delta.cache_write_input_tokens, delta.input_tokens - cached);
      add(summary, at, summary.branch, model, [delta.input_tokens - cached - written, delta.output_tokens, written, 0, cached, 1]);
    }
  }
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
  const groups = new Map<string, { tool: Tool; files: { file: string; depth: number; summary: FileSummary }[] }>();
  for (const { tool, dir } of sources) {
    for (const file of await logsUnder(dir, since)) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const hit = cache.files[file];
      const fresh = hit && hit.tool === tool && hit.size === info.size && hit.mtimeMs === info.mtimeMs;
      const summary = fresh ? hit.summary : await (tool === "claude" ? summarizeClaude(file) : summarizeCodex(file)).catch(emptySummary);
      next.files[file] = { tool, size: info.size, mtimeMs: info.mtimeMs, summary };
      const parts = path.relative(dir, file).split(path.sep);
      if (tool === "codex" && !summary.cwd) continue;
      const key = tool === "claude" ? `claude\n${parts[0]}` : `codex\n${path.normalize(summary.cwd!)}`;
      const group = groups.get(key) ?? { tool, files: [] };
      group.files.push({ file, depth: parts.length, summary });
      groups.set(key, group);
    }
  }
  await saveCache(next).catch(() => undefined);

  const folders = new Map<string, string>();
  const logs = new Map<string, string>();
  const projects: ProjectActivity[] = [];
  type SessionSum = Omit<SessionActivity, "usage"> & { models: Map<string, Counts> };
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
    const ids = new Set<string>();
    for (const { file, depth, summary } of files) {
      if (summary.lastActive >= lastActive) {
        lastActive = summary.lastActive;
        branch = summary.branch ?? branch;
      }
      for (const [key, counts] of Object.entries(summary.rows)) addCounts(rows, key, counts);
      if (!summary.session) continue;
      const id = tool === "codex" ? rootOf(summary.session) : summary.session;
      ids.add(id);
      const own = tool === "codex" ? id === summary.session : depth <= 2;
      const key = `${tool}:${id}`;
      const s: SessionSum = sessions.get(key) ?? { tool, id, path: shown, title: null, branch: null, source: null, startedAt: 0, lastActive: 0, subagents: 0, models: new Map() };
      sessions.set(key, s);
      if (own) {
        logs.set(key, file);
        s.path = shown; // a sub-agent may have started elsewhere: the session is where its own log says
        s.title = (tool === "codex" ? names.get(id) : null) ?? summary.title ?? summary.prompt ?? s.title;
        s.source = summary.source ?? s.source;
      } else s.subagents += 1;
      if (summary.startedAt && (!s.startedAt || summary.startedAt < s.startedAt)) s.startedAt = summary.startedAt;
      if (summary.lastActive >= s.lastActive) {
        s.lastActive = summary.lastActive;
        s.branch = summary.branch ?? s.branch;
      }
      for (const [key2, counts] of Object.entries(summary.rows)) addCounts(s.models, key2.split("\t")[1], counts);
    }
    const kept: TokenRow[] = rowsOf(rows)
      .filter((r) => r.day >= days[0])
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1));
    if (kept.length === 0) continue;
    folders.set(shown, cwd);
    projects.push({ tool, path: shown, name: path.basename(cwd) || shown, branch, lastActive, sessions: ids.size, rows: kept });
  }
  projects.sort((a, b) => b.lastActive - a.lastActive);

  const reported: SessionActivity[] = [...sessions.values()]
    .filter((s) => s.lastActive >= since && folders.has(s.path))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, MAX_SESSIONS)
    .map(({ models, ...s }) => ({ ...s, usage: [...models].map(([model, [input, output, cacheWrite, cacheWrite1h, cacheRead, messages]]): ModelUsage => ({ model, input, output, cacheWrite, cacheWrite1h, cacheRead, messages })) }));
  return { activity: { scannedAt: now, days: DAYS, projects, sessions: reported }, folders, logs };
}
