"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  claudeChatsAction,
  fetchClaudeChats,
  placeName,
  samePlace,
  type ChatPlace,
  type ClaudeAppChat,
  type ClaudeAppPlace,
  type ClaudeAppState,
  type ClaudeChatsAction,
} from "@/lib/claude-chats";
import { useCommands } from "@/lib/commands";
import { formatAgo } from "@/lib/format";
import { toast } from "@/lib/ui";
import { Icon } from "./Icon";
import { CloseButton, Modal } from "./Modal";
import { ProviderGlyph } from "./ProviderLogo";

const key = (p: ChatPlace) => `${p.account}/${p.org}`;

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The last part of a folder path: "AIUsageTracker" for C:\Users\...\AIUsageTracker. */
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

/** A place as the selects and toasts say it: the account, its organization when it has chats in more than one. */
function placeLabel(p: ClaudeAppPlace, places: ClaudeAppPlace[]): string {
  const several = places.filter((o) => o.account === p.account).length > 1;
  return several ? `${placeName(p)} · ${p.orgName ?? `organization ${p.org.slice(0, 8)}`}` : placeName(p);
}

/** Runs an action and reports how it went; returns the new state, or null when it failed. */
async function act(body: ClaudeChatsAction) {
  const res = await claudeChatsAction(body);
  if (!res.ok) {
    toast(res.error, { tone: "error" });
    return null;
  }
  return res.data;
}

/**
 * "This machine": the Claude app's chats, a list per account on this
 * computer. Signed in with another account, the app shows only that one's;
 * this copies or moves chats to the account in use (server/local/claude-app.ts).
 */
export function ClaudeChats({ now }: { now: number }) {
  /** undefined until known; null where this copy cannot see the app's chats (the website). */
  const [state, setState] = useState<ClaudeAppState | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<{ account: string; draft: string } | null>(null);

  async function load() {
    const next = await fetchClaudeChats();
    if (next) setState(next);
  }

  useEffect(() => {
    let alive = true;
    void fetchClaudeChats().then((first) => alive && setState(first));
    // Switching account in the Claude app, then coming back here: the counts follow.
    const onFocus = () => void fetchClaudeChats().then((next) => alive && next && setState(next));
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const places = state?.places ?? [];
  const usable = places.length >= 2;

  useCommands("claude-chats", () =>
    usable
      ? [
          {
            id: "claude-chats",
            title: "Copy or move Claude app chats between accounts",
            group: "This machine",
            icon: "copy",
            keywords: "claude desktop code sessions transfer switch account move",
            run: () => setOpen(true),
          },
        ]
      : [],
  );

  async function undo(operation: string) {
    const data = await act({ action: "undo", operation });
    if (!data) return;
    setState(data.state);
    const kept = data.result?.kept ?? 0;
    toast(
      kept > 0
        ? `Undone, except ${kept} chat${kept === 1 ? "" : "s"} worked in since, which stay${kept === 1 ? "s" : ""}.`
        : "Undone: the copies are gone, and moved chats are back where they were.",
    );
  }

  async function saveName() {
    if (!naming) return;
    const { account, draft } = naming;
    setNaming(null);
    const data = await act({ action: "name", account, name: draft.trim() || null });
    if (data) setState(data.state);
  }

  if (!state?.found) return null;

  return (
    <div className="mt-4 rounded-2xl border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-fg-2">
          <ProviderGlyph provider="claude" size={16} />
          Claude app chats
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="rounded-lg p-1.5 text-muted transition hover:bg-panel-3 hover:text-fg" aria-label="Read the chats again" title="Read again">
            <Icon name="refresh" size={14} />
          </button>
          <button type="button" onClick={() => setOpen(true)} disabled={!usable} className="btn btn-primary">
            <Icon name="copy" />
            Copy or move chats…
          </button>
        </div>
      </header>
      <p className="px-4 pt-3 text-xs text-muted">
        The Claude app keeps its Code tab&apos;s chats on this computer, a list per account: signed in with another account, the others&apos; seem gone. Copy or
        move them to the account you use now. Chats in the app&apos;s Chat tab live on Anthropic&apos;s servers, per account, and can&apos;t be moved this way.
      </p>
      <ul className="divide-y divide-line px-4">
        {places.map((p) => (
          <li key={key(p)} className="flex flex-wrap items-center gap-2 py-2.5">
            {naming?.account === p.account ? (
              <input
                autoFocus
                value={naming.draft}
                onChange={(e) => setNaming({ account: p.account, draft: e.target.value })}
                onBlur={() => void saveName()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setNaming(null);
                }}
                placeholder="work@example.com, Personal…"
                aria-label="Name for this account"
                className="min-w-0 flex-1 border-b border-muted bg-transparent text-sm text-fg focus:outline-none"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={`Account ${p.account}, organization ${p.org}`}>
                {placeLabel(p, places)}
              </span>
            )}
            {p.current && <span className="chip chip-good">signed in to Claude now</span>}
            <span className="font-mono text-[11px] text-faint tabular-nums">
              {p.chats.length} chat{p.chats.length === 1 ? "" : "s"}
            </span>
            {naming?.account !== p.account && (
              <button type="button" onClick={() => setNaming({ account: p.account, draft: p.label ?? "" })} className="text-[11px] text-faint hover:text-fg">
                {p.label ? "rename" : "name it"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!usable && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-muted">
          Only one account&apos;s chats are here. Sign in to another account in the Claude app once, and it shows here to copy to.
        </p>
      )}
      {state.history.length > 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <p className="eyebrow mb-1.5">recently</p>
          <ul className="space-y-1">
            {state.history.slice(0, 3).map((op) => {
              const to = places.find((p) => samePlace(p, op.to));
              return (
                <li key={op.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-2">
                  <span className="min-w-0 truncate">
                    {op.kind === "copy" ? "Copied" : "Moved"} {op.items.length} chat{op.items.length === 1 ? "" : "s"} to {to ? placeLabel(to, places) : "another account"}
                    <span className="text-faint"> · {formatAgo(now - op.at)}</span>
                  </span>
                  {op.undone ? (
                    <span className="text-faint" title={op.undone.kept > 0 ? "Chats worked in since the copy stay" : undefined}>
                      undone{op.undone.kept > 0 ? ` · ${op.undone.kept} kept` : ""}
                    </span>
                  ) : (
                    <button type="button" onClick={() => void undo(op.id)} className="text-muted hover:text-fg">
                      undo
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {state.running && (
        <p className="flex items-start gap-1.5 border-t border-line px-4 py-2.5 text-[11px] text-faint">
          <Icon name="info" size={12} className="mt-px shrink-0" />
          The Claude app is open: it shows copied chats once you switch to that account in it, or reopen it. A chat open in it can be copied, and moved once it
          is closed.
        </p>
      )}
      {open && usable && <ChatsDialog state={state} now={now} onState={setState} onUndo={(op) => void undo(op)} onClose={() => setOpen(false)} />}
    </div>
  );
}

type DialogProps = {
  state: ClaudeAppState;
  now: number;
  onState: (next: ClaudeAppState) => void;
  onUndo: (operation: string) => void;
  onClose: () => void;
};

/** Picks where from, where to and which chats; copies or moves them. */
function ChatsDialog({ state, now, onState, onUndo, onClose }: DialogProps) {
  const titleId = useId();
  const places = state.places;
  // Usually: the chats of an account used before, to the one the app is signed in with now.
  const [toKey, setToKey] = useState(() => key(places.find((p) => p.current && p.home) ?? places.find((p) => p.home) ?? places[0]));
  const [fromKey, setFromKey] = useState(
    () => key([...places].filter((p) => key(p) !== toKey).sort((a, b) => b.chats.length - a.chats.length)[0] ?? places[1]),
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"copy" | "move" | null>(null);

  const from = places.find((p) => key(p) === fromKey) ?? places[0];
  const to = places.find((p) => key(p) === toKey && key(p) !== fromKey) ?? places.find((p) => key(p) !== fromKey)!;
  const copiedThere = useCallback((c: ClaudeAppChat) => c.copiedTo.some((t) => samePlace(t, to)), [to]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return from.chats.filter((c) => words.every((w) => `${c.title} ${c.cwd} ${c.model ?? ""}`.toLowerCase().includes(w)));
  }, [from, query]);
  const selectable = shown.filter((c) => c.bytes !== null);
  const chosen = from.chats.filter((c) => picked.has(c.id));
  const chosenBytes = chosen.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
  const openInApp = chosen.filter((c) => c.inUse).length;
  const allShownPicked = selectable.length > 0 && selectable.every((c) => picked.has(c.id));

  function pickFrom(next: string) {
    setFromKey(next);
    setPicked(new Set());
    if (next === toKey) setToKey(fromKey);
  }

  function swap() {
    setFromKey(key(to));
    setToKey(key(from));
    setPicked(new Set());
  }

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  /** Every chat shown that is not in the other account yet; or none, when they all are picked. */
  function pickAll() {
    if (allShownPicked) return setPicked(new Set());
    const fresh = selectable.filter((c) => !copiedThere(c));
    setPicked(new Set((fresh.length > 0 ? fresh : selectable).map((c) => c.id)));
  }

  async function run(kind: "copy" | "move") {
    setBusy(kind);
    const data = await act({ action: kind, from: { account: from.account, org: from.org }, to: { account: to.account, org: to.org }, chats: [...picked] });
    setBusy(null);
    if (!data) return;
    onState(data.state);
    setPicked(new Set());
    const result = data.result;
    if (!result) return;
    const target = placeLabel(to, places);
    if (result.done > 0 && result.operation) {
      const operation = result.operation;
      toast(
        `${kind === "copy" ? "Copied" : "Moved"} ${result.done} chat${result.done === 1 ? "" : "s"} to ${target}.${
          state.running ? " Switch to that account in the Claude app, or reopen it, to see them." : " They show next time the app opens with that account."
        }`,
        { duration: 12_000, action: { label: "Undo", run: () => onUndo(operation) } },
      );
    }
    for (const skip of result.skipped.slice(0, 3)) toast(`Not ${kind === "copy" ? "copied" : "moved"}: “${skip.title}”, ${skip.reason}.`, { tone: "error", duration: 10_000 });
    if (result.skipped.length > 3) toast(`${result.skipped.length - 3} more were not ${kind === "copy" ? "copied" : "moved"}.`, { tone: "error" });
    if (result.done > 0) onClose();
  }

  const select = "min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-fg focus:border-muted focus:outline-none";

  return (
    <Modal onClose={onClose} labelledBy={titleId} className="max-w-3xl overflow-hidden">
      <div className="flex max-h-[calc(100dvh-var(--tb-h)-2rem)] flex-col">
        <div className="border-b border-line p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-lg font-semibold text-fg">
              Copy or move Claude app chats
            </h2>
            <CloseButton onClick={onClose} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="flex min-w-60 flex-1 items-center gap-2">
              <span className="text-xs text-muted">From</span>
              <select value={key(from)} onChange={(e) => pickFrom(e.target.value)} className={select}>
                {places.map((p) => (
                  <option key={key(p)} value={key(p)}>
                    {placeLabel(p, places)}
                    {p.current ? " (signed in now)" : ""} · {p.chats.length} chats
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={swap} className="btn px-2" aria-label="Swap from and to" title="Swap">
              <Icon name="swap" />
            </button>
            <label className="flex min-w-60 flex-1 items-center gap-2">
              <span className="text-xs text-muted">To</span>
              <select value={key(to)} onChange={(e) => setToKey(e.target.value)} className={select}>
                {places
                  .filter((p) => key(p) !== key(from))
                  .map((p) => (
                    <option key={key(p)} value={key(p)}>
                      {placeLabel(p, places)}
                      {p.current ? " (signed in now)" : ""}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5">
              <Icon name="search" size={13} className="text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles and folders"
                aria-label="Search chats"
                data-autofocus
                className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
              />
            </div>
            <button type="button" onClick={pickAll} disabled={selectable.length === 0} className="btn">
              <Icon name={allShownPicked ? "x" : "check"} />
              {allShownPicked ? "Select none" : "Select all"}
            </button>
          </div>
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" aria-label={`Chats of ${placeLabel(from, places)}`}>
          {shown.length === 0 && (
            <li className="px-5 py-10 text-center text-sm text-muted">{from.chats.length === 0 ? "This account has no chats in the Claude app." : "No chat matches."}</li>
          )}
          {shown.map((c) => {
            const missing = c.bytes === null;
            return (
              <li key={c.id}>
                <label className={`flex items-start gap-3 px-5 py-2.5 ${missing ? "opacity-50" : "cursor-default hover:bg-panel-2"}`}>
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    disabled={missing}
                    onChange={() => toggle(c.id)}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm text-fg">{c.title}</span>
                      {copiedThere(c) && <span className="chip chip-good">already there</span>}
                      {c.copiedFrom && <span className="chip">a copy</span>}
                      {c.archived && <span className="chip">archived</span>}
                      {c.inUse && <span className="chip chip-warn">open in Claude</span>}
                      {missing && <span className="chip chip-bad">conversation missing</span>}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-faint" title={c.cwd}>
                      {folderName(c.cwd)} · {c.lastActivityAt ? formatAgo(now - c.lastActivityAt) : "never used"}
                      {c.turns !== null && ` · ${c.turns} turn${c.turns === 1 ? "" : "s"}`}
                      {c.model && ` · ${c.model.replace(/^claude-/, "")}`}
                      {c.bytes !== null && ` · ${size(c.bytes)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-line p-5">
          <p className="text-xs text-muted">
            A copy keeps the chat in both accounts, each carrying on by itself. Moving takes it out of {placeLabel(from, places)}; both can be undone.
            {openInApp > 0 && ` ${openInApp} of the chats picked ${openInApp === 1 ? "is" : "are"} open in the Claude app: copy ${openInApp === 1 ? "it" : "them"}, or move once the app is closed.`}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-faint tabular-nums">
              {chosen.length > 0 ? `${chosen.length} chat${chosen.length === 1 ? "" : "s"} · ${size(chosenBytes)}` : "no chats picked"}
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn">
                Cancel
              </button>
              <button type="button" onClick={() => void run("move")} disabled={busy !== null || chosen.length === 0 || openInApp === chosen.length} className="btn">
                {busy === "move" ? "Moving…" : `Move${chosen.length ? ` ${chosen.length}` : ""}`}
              </button>
              <button type="button" onClick={() => void run("copy")} disabled={busy !== null || chosen.length === 0} className="btn btn-primary">
                {busy === "copy" ? "Copying…" : `Copy${chosen.length ? ` ${chosen.length}` : ""} to ${placeName(to)}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
