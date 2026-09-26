"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatAgo } from "@/lib/format";
import { toast } from "@/lib/ui";
import { Icon } from "./Icon";

/** One turn of the icon: a quick answer still shows that something happened. */
const MIN_BUSY_MS = 700;

/**
 * A refresh someone asked for, by a click or a shortcut: busy until `load` has
 * answered, and for one turn of the icon at least, one at a time. `load`
 * returns why it failed, if it did, and that is said in a toast; polls in the
 * background call their loaders directly and stay quiet.
 */
export function useRefresh(load: () => Promise<string | null | void>): [busy: boolean, refresh: () => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const started = Date.now();
    let problem: string | null | void = null;
    try {
      problem = await latest.current();
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + MIN_BUSY_MS - Date.now())));
    running.current = false;
    setBusy(false);
    if (problem) toast(`Couldn't refresh: ${problem}`, { tone: "error" });
  }, []);

  return [busy, refresh];
}

/** "just now", "4m ago", "2h 5m ago": to the minute, so a label beside the button does not tick every second. */
function updatedAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes}m ago` : formatAgo(ms);
}

type Props = {
  /** What it reads again, as the tooltip and screen readers say it: "Refresh the team". */
  label: string;
  busy: boolean;
  onRefresh: () => void;
  /** When what it shows was read: the tooltip says how long ago, and with `showAge` so does the button, in a wide window. */
  updatedAt?: number | null;
  now?: number;
  showAge?: boolean;
  shortcut?: string;
  /** A labelled button ("Try again"), for toolbars and messages, instead of a quiet icon for a card's header. */
  text?: string;
  disabled?: boolean;
  size?: number;
  className?: string;
};

/**
 * The refresh button everywhere: its icon turns while it reads, in the accent
 * colour, which is what shows with reduced motion. It stays enabled meanwhile,
 * so keyboard focus stays on it; pressing it again waits for the first read.
 */
export function RefreshButton({ label, busy, onRefresh, updatedAt, now, showAge, shortcut, text, disabled, size = 14, className = "" }: Props) {
  const age = updatedAt && now !== undefined ? `updated ${updatedAgo(Math.max(0, now - updatedAt))}` : null;
  const title = [shortcut ? `${label} (${shortcut})` : label, busy ? "refreshing…" : age].filter(Boolean).join(" · ");
  const shared = { type: "button" as const, onClick: () => busy || onRefresh(), disabled, "aria-busy": busy, title };
  const icon = <Icon name="refresh" size={size} className={busy ? "spin" : undefined} />;

  if (text) {
    return (
      <button {...shared} className={`btn ${busy ? "text-accent" : ""} ${className}`}>
        {icon}
        {text}
      </button>
    );
  }
  return (
    <button
      {...shared}
      aria-label={label}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg p-1.5 transition hover:bg-panel-3 hover:text-fg disabled:opacity-40 ${busy ? "text-accent" : "text-muted"} ${className}`}
    >
      {icon}
      {showAge && age && <span className="hidden pr-0.5 font-mono text-[11px] lg:inline">{age}</span>}
    </button>
  );
}
