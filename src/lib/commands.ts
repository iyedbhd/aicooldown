import { useEffect, useRef } from "react";
import type { IconName } from "@/components/Icon";

/** Something the command palette (Ctrl+K) offers. */
export type AppCommand = {
  id: string;
  title: string;
  /** The heading it is listed under. */
  group: string;
  /** Other words that find it. */
  keywords?: string;
  /** Its keyboard shortcut, as shown: "Ctrl+R". */
  shortcut?: string;
  icon?: IconName;
  run: () => void;
};

/*
 * Whoever has commands to offer registers a function that lists them, read
 * only when the palette opens, so the list is always current and registering
 * costs nothing while it is closed.
 */
const sources = new Map<string, () => AppCommand[]>();

export function registerCommands(source: string, list: () => AppCommand[]): () => void {
  sources.set(source, list);
  return () => {
    if (sources.get(source) === list) sources.delete(source);
  };
}

export function allCommands(): AppCommand[] {
  return [...sources.values()].flatMap((list) => list());
}

/** Offers the commands `list` returns while the component is mounted; `list` may use the latest props and state. */
export function useCommands(source: string, list: () => AppCommand[]): void {
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  useEffect(() => registerCommands(source, () => latest.current()), [source]);
}

/** Scores a command against what was typed: every word must appear; earlier and word-start matches rank higher. */
export function matchScore(command: AppCommand, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const title = command.title.toLowerCase();
  const haystack = `${title} ${command.group.toLowerCase()} ${command.keywords?.toLowerCase() ?? ""}`;
  let score = 0;
  for (const word of words) {
    const at = haystack.indexOf(word);
    if (at < 0) return 0;
    const inTitle = title.indexOf(word);
    score += inTitle === 0 ? 30 : inTitle > 0 && /\s/.test(title[inTitle - 1]) ? 20 : inTitle > 0 ? 10 : 4;
  }
  return score;
}
