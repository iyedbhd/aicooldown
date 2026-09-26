"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pushLayer } from "@/lib/ui";
import { Icon, type IconName } from "./Icon";

export type MenuItem =
  | { label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; checked?: boolean; run: () => void }
  | "separator";

/** Where a menu opens: at a point (a right-click) or under an element (its button). */
export type MenuAnchor = { x: number; y: number } | { element: HTMLElement };

type Props = { anchor: MenuAnchor; items: MenuItem[]; onClose: () => void; label: string };

const GAP = 4;

/**
 * Focus back to what had it, unless something else (a field the picked item
 * opened) took it meanwhile. A tick later: a closing dialog leaves the page
 * behind it inert until the shell renders again.
 */
export function restoreFocus(to: Element | null): void {
  if (!(to instanceof HTMLElement)) return;
  setTimeout(() => {
    const now = document.activeElement;
    if ((now === null || now === document.body) && to.isConnected) to.focus({ preventScroll: true });
  }, 0);
}

/**
 * A small popup menu in the style of Windows 11's: rounded, with icons and
 * hints. Arrow keys move, Enter picks, Escape (through the layer stack),
 * Tab, a click elsewhere, scrolling or resizing close it. Focus goes back to
 * where it was.
 */
export function Menu({ anchor, items, onClose, label }: Props) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const [opener] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => pushLayer({ id, modal: false, onEscape: () => close.current() }), [id]);

  // Placed after it is measured: below and right of the point, flipped to stay on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let x: number;
    let y: number;
    if ("element" in anchor) {
      const r = anchor.element.getBoundingClientRect();
      x = r.right - width;
      y = r.bottom + GAP;
      if (y + height > window.innerHeight - GAP) y = r.top - height - GAP;
    } else {
      x = anchor.x;
      y = anchor.y;
      if (y + height > window.innerHeight - GAP) y = anchor.y - height;
    }
    x = Math.min(Math.max(GAP, x), window.innerWidth - width - GAP);
    y = Math.min(Math.max(GAP, y), window.innerHeight - height - GAP);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
    el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor]);

  useEffect(() => {
    const outside = (e: Event) => {
      const target = e.target as Node;
      // Its own button toggles it on click instead.
      if (box.current?.contains(target) || ("element" in anchor && e.type === "mousedown" && anchor.element.contains(target))) return;
      close.current();
    };
    const away = () => close.current();
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    window.addEventListener("scroll", away, true);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
      window.removeEventListener("scroll", away, true);
      restoreFocus(opener);
    };
  }, [opener, anchor]);

  function onKeyDown(e: React.KeyboardEvent) {
    const entries = [...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      entries[(to + entries.length) % entries.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(entries.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      close.current();
    }
  }

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="menu fixed z-[75] min-w-[13rem] rounded-xl border border-line bg-panel p-1 shadow-xl"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={`sep-${i}`} role="separator" className="mx-1 my-1 h-px bg-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (item.disabled) return;
              close.current();
              item.run();
            }}
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none transition-colors focus:bg-panel-3 enabled:hover:bg-panel-3 ${
              item.disabled ? "text-faint" : item.danger ? "text-rose-600 dark:text-rose-400" : "text-fg-2 hover:text-fg focus:text-fg"
            }`}
          >
            <span className="flex w-4 shrink-0 justify-center">
              {item.checked ? <Icon name="check" size={14} /> : item.icon ? <Icon name={item.icon} size={14} /> : null}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 font-mono text-[10.5px] text-faint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
