import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { Tool } from "@/lib/activity";
import { IMAGE_TYPES, type ImageRef, type ImageType, type RunEventKind } from "@/lib/team";
import { claudePrompt, codexPrompt, parse } from "./activity";

/*
 * A session's conversation, read from the CLI's own log when someone with the
 * right to see it asks and this computer shares session content: what was
 * asked, what the model said, the tools it used and what they returned. Long
 * texts and outputs are cut, and a very long session keeps its latest part.
 * Images (pasted with a prompt, or a screenshot or file a tool returned) show
 * as a note of which one they are; each is read again when someone opens it.
 */

export type TranscriptEvent = { at: number; kind: RunEventKind; text: string };

const MAX_TEXT = 4_000;
const MAX_OUTPUT = 1_500;
const MAX_EVENTS = 1_500;
const MAX_CHARS = 1_500_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** One line for a tool call: its name and what it works on. */
export function describeTool(name: string, input: unknown): string {
  const v = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target = [v.command, v.cmd, v.file_path, v.path, v.pattern, v.url, v.query, v.description, v.prompt].find((x): x is string => typeof x === "string" && x.length > 0);
  if (/^(bash|shell|exec_command|powershell)$/i.test(name) && target) return `$ ${clip(target, 300)}`;
  return clip(target ? `${name} ${target}` : name, 300);
}

/** What a tool returned, as text. */
export function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

function lines(file: string): readline.Interface {
  return readline.createInterface({ input: createReadStream(/* turbopackIgnore: true */ file), crlfDelay: Infinity });
}

/** An image as a log keeps it: base64, of a kind a browser shows safely, pasted with a prompt or returned by a tool. */
export type LoggedImage = { type: ImageType; data: string; by: ImageRef["by"] };

/** How many bytes base64 `data` decodes to. */
export const decodedBytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

function base64Image(block: Record<string, unknown>, by: LoggedImage["by"], out: LoggedImage[]): void {
  const src = block.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
  if (src?.type === "base64" && IMAGE_TYPES.includes(src.media_type as ImageType) && typeof src.data === "string") out.push({ type: src.media_type as ImageType, data: src.data, by });
}

/** The images of a Claude Code log entry, in order: pasted with its prompt, or in what a tool returned. */
function claudeImages(entry: Record<string, unknown>): LoggedImage[] {
  const out: LoggedImage[] = [];
  const content = entry.type === "user" && !entry.isSidechain ? (entry.message as { content?: unknown } | undefined)?.content : undefined;
  if (!Array.isArray(content)) return out;
  for (const b of content as Record<string, unknown>[]) {
    if (b?.type === "image") base64Image(b, "user", out);
    else if (b?.type === "tool_result" && Array.isArray(b.content)) for (const c of b.content as Record<string, unknown>[]) if (c?.type === "image") base64Image(c, "tool", out);
  }
  return out;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/;

/** The images of a Codex log entry: in a message (pasted with a prompt), or in what a tool returned. A compaction repeats earlier ones, which count once. */
function codexImages(entry: Record<string, unknown>): LoggedImage[] {
  const out: LoggedImage[] = [];
  const p = entry.type === "response_item" ? (entry.payload as Record<string, unknown> | undefined) : undefined;
  const list = p?.type === "message" ? p.content : p?.type === "function_call_output" || p?.type === "custom_tool_call_output" ? p.output : undefined;
  if (!Array.isArray(list)) return out;
  const by = p?.type === "message" && p.role === "user" ? "user" : "tool";
  for (const c of list as Record<string, unknown>[]) {
    const m = c?.type === "input_image" && typeof c.image_url === "string" ? DATA_URL.exec(c.image_url) : null;
    if (m) out.push({ type: m[1] as ImageType, data: m[2], by });
  }
  return out;
}

const imagesOf = (tool: Tool, entry: Record<string, unknown>) => (tool === "claude" ? claudeImages(entry) : codexImages(entry));

/** Whether a log line can hold an image, before parsing it: the CLIs write their JSON without spaces. */
const mayHoldImage = (tool: Tool, line: string) => line.includes(tool === "claude" ? '"type":"image"' : '"input_image"');

/** The note a transcript has for an image: which one it is (counted from 0 in the log), its kind, size and where it came from. */
const imageNote = (n: number, image: LoggedImage) => JSON.stringify({ n, type: image.type, bytes: decodedBytes(image.data), by: image.by } satisfies ImageRef);

/** The images numbered `wanted` (see ImageRef.n) in `file`, a `tool` session log, as it keeps them. */
export async function readImages(tool: Tool, file: string, wanted: Set<number>): Promise<Map<number, LoggedImage>> {
  const found = new Map<number, LoggedImage>();
  let n = 0;
  for await (const line of lines(file)) {
    if (!mayHoldImage(tool, line)) continue;
    const entry = parse(line);
    if (!entry) continue;
    for (const image of imagesOf(tool, entry)) {
      if (wanted.has(n)) found.set(n, image);
      n += 1;
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

async function readClaude(file: string, push: (at: number, kind: RunEventKind, text: string) => void): Promise<void> {
  const blocks = new Set<string>();
  let images = 0;
  for await (const line of lines(file)) {
    const entry = parse(line);
    if (!entry || entry.isSidechain) continue;
    const at = Date.parse(String(entry.timestamp)) || 0;
    if (entry.type === "user") {
      const prompt = claudePrompt(entry);
      if (prompt) push(at, "user", clip(prompt, MAX_TEXT));
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b?.type === "tool_result") push(at, b.is_error ? "error" : "output", clip(outputText(b.content), MAX_OUTPUT));
        }
      }
      for (const image of claudeImages(entry)) push(at, "image", imageNote(images++, image));
    } else if (entry.type === "assistant") {
      const message = entry.message as { id?: unknown; content?: unknown } | undefined;
      if (!Array.isArray(message?.content)) continue;
      (message.content as Record<string, unknown>[]).forEach((b, i) => {
        // Each content block is written once, but a reply's blocks can repeat across lines.
        const key = `${message.id}:${entry.apiBlockIndex ?? i}:${b?.type}`;
        if (blocks.has(key)) return;
        blocks.add(key);
        if (b?.type === "text" && typeof b.text === "string") push(at, "text", clip(b.text, MAX_TEXT));
        else if (b?.type === "tool_use") push(at, "tool", describeTool(String(b.name), b.input));
      });
    } else if (entry.type === "system" && entry.subtype === "compact_boundary") {
      push(at, "info", "Context compacted");
    }
  }
}

type CodexItem = Record<string, unknown> & { type?: string };

type Step = { line: number; at: number; kind: RunEventKind; text: string };

/** Codex's own summary of each step (newer versions), or failing that its raw model items; with the images, which only raw items carry. */
async function readCodex(file: string, emit: (at: number, kind: RunEventKind, text: string) => void): Promise<void> {
  const items: Step[] = [];
  const raw: Step[] = [];
  const pictures: (Step & { by: LoggedImage["by"] })[] = [];
  let hasItems = false;
  let line = 0;
  const push = (at: number, kind: RunEventKind, text: string) => items.push({ line, at, kind, text });
  const rawPush = (at: number, kind: RunEventKind, text: string) => raw.push({ line, at, kind, text });
  for await (const text of lines(file)) {
    line += 1;
    if (!text.includes('"item_completed"') && !text.includes('"response_item"') && !text.includes('"user_message"')) continue;
    const entry = parse(text);
    const p = entry?.payload as Record<string, unknown> | undefined;
    if (!entry || !p) continue;
    const at = Date.parse(String(entry.timestamp)) || 0;
    for (const image of codexImages(entry)) pictures.push({ line, at, kind: "image", text: imageNote(pictures.length, image), by: image.by });
    if (p.type === "item_completed" && p.item && typeof p.item === "object") {
      hasItems = true;
      const item = p.item as CodexItem;
      const texts = (item.content as { text?: unknown }[] | undefined)?.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n") ?? "";
      if (item.type === "UserMessage" && texts.trim()) push(at, "user", clip(codexPrompt(texts), MAX_TEXT));
      else if (item.type === "AgentMessage" && texts.trim()) push(at, "text", clip(texts, MAX_TEXT));
      else if (item.type === "CommandExecution") {
        const parsed = (item.parsed_cmd as { cmd?: unknown }[] | undefined)?.[0]?.cmd;
        const command = typeof parsed === "string" ? parsed : Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
        push(at, "tool", `$ ${clip(command, 300)}`);
        const out = String(item.aggregated_output ?? item.stdout ?? "");
        if (out.trim()) push(at, item.exit_code && item.exit_code !== 0 ? "error" : "output", clip(out, MAX_OUTPUT));
      } else if (item.type === "FileChange") {
        const changed = item.changes && typeof item.changes === "object" ? Object.keys(item.changes as object) : [];
        push(at, "tool", clip(`Edit ${changed.join(", ")}`, 300));
      } else if (item.type === "McpToolCall") {
        push(at, "tool", `${item.server}.${item.tool}`);
        const result = outputText((item.result as { content?: unknown } | undefined)?.content);
        if (result.trim()) push(at, "output", clip(result, MAX_OUTPUT));
      } else if (item.type === "ContextCompaction") push(at, "info", "Context compacted");
    } else if (p.type === "user_message" && typeof p.message === "string") {
      rawPush(at, "user", clip(codexPrompt(p.message), MAX_TEXT));
    } else if (entry.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") {
        const said = outputText(p.content);
        if (said.trim()) rawPush(at, "text", clip(said, MAX_TEXT));
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        let input: unknown = p.input;
        if (typeof p.arguments === "string") input = parse(p.arguments) ?? p.arguments;
        rawPush(at, "tool", describeTool(String(p.name), input));
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const out = typeof p.output === "string" ? p.output : outputText(p.output);
        if (out.trim()) rawPush(at, "output", clip(out, MAX_OUTPUT));
      }
    }
  }
  const steps = hasItems ? items : raw;
  // A pasted image is logged just before the prompt it came with: it shows after that prompt.
  const placed = pictures.map((p) => {
    const prompt = p.by === "user" ? steps.find((s) => s.kind === "user" && s.line >= p.line) : undefined;
    return prompt ? { ...p, line: prompt.line + 0.5 } : p;
  });
  for (const e of [...steps, ...placed].sort((a, b) => a.line - b.line)) emit(e.at, e.kind, e.text);
}

/** The conversation in `file`, a `tool` session log; its latest part when it is very long. */
export async function readTranscript(tool: Tool, file: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  const push = (at: number, kind: RunEventKind, text: string) => {
    if (text.trim()) events.push({ at, kind, text });
  };
  await (tool === "claude" ? readClaude(file, push) : readCodex(file, push));
  let chars = 0;
  let from = events.length;
  while (from > 0 && events.length - from < MAX_EVENTS && chars + events[from - 1].text.length <= MAX_CHARS) {
    from -= 1;
    chars += events[from].text.length;
  }
  if (from === 0) return events;
  return [{ at: events[from].at, kind: "info", text: `The first ${from} entries of this long session are left out.` }, ...events.slice(from)];
}
