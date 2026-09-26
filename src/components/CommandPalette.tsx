"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { allCommands, matchScore, type AppCommand } from "@/lib/commands";
import { Keys } from "./Controls";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

/**
 * Ctrl+K: every command the shell and the page showing offer, found by typing.
 * Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // What is on offer when it opens; the commands themselves read the latest state when run.
  const [commands] = useState<AppCommand[]>(allCommands);
  const list = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((command, order) => ({ command, order, score: matchScore(command, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((r) => r.command);
  }, [commands, query]);

  const current = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function run(command: AppCommand | undefined) {
    if (!command) return;
    onClose();
    command.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(results[current]);
    }
  }

  // Listed under their groups when nothing is typed; by relevance, with the group as a hint, when something is.
  const grouped = !query.trim();

  return (
    <Modal onClose={onClose} label="Command palette" placement="top" className="max-w-xl overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Icon name="search" size={15} className="shrink-0 text-muted" />
        <input
          data-autofocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search accounts and commands…"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
          aria-label="Search commands"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-none"
          spellCheck={false}
          autoComplete="off"
        />
        <Keys keys="Esc" />
      </div>
      <ul ref={list} id={listId} role="listbox" aria-label="Commands" className="max-h-[min(26rem,60vh)] overflow-y-auto p-1.5">
        {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches “{query}”.</li>}
        {results.map((command, i) => {
          const heading = grouped && (i === 0 || results[i - 1].group !== command.group) ? command.group : null;
          return (
            <li key={command.id} role="presentation">
              {heading && <p className="px-2.5 pt-2.5 pb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">{heading}</p>}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                data-index={i}
                onMouseMove={() => i !== current && setActive(i)}
                onClick={() => run(command)}
                className={`flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px] ${i === current ? "bg-panel-3 text-fg" : "text-fg-2"}`}
              >
                <span className="flex w-4 shrink-0 justify-center text-muted">{command.icon && <Icon name={command.icon} size={14} />}</span>
                <span className="flex-1 truncate">{command.title}</span>
                {!grouped && <span className="shrink-0 text-[11px] text-faint">{command.group}</span>}
                {command.shortcut && <Keys keys={command.shortcut} />}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-faint">
        <span className="flex items-center gap-1.5">
          <Keys keys="↑" />
          <Keys keys="↓" /> move
        </span>
        <span className="flex items-center gap-1.5">
          <Keys keys="Enter" /> run
        </span>
      </p>
    </Modal>
  );
}
