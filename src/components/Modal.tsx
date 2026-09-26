"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getLayers, pushLayer, subscribeLayers } from "@/lib/ui";
import { Icon } from "./Icon";
import { restoreFocus } from "./Menu";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  onClose: () => void;
  /** The id of the heading that names the dialog, or a label when it has none. */
  labelledBy?: string;
  label?: string;
  /** Classes for the panel: its width, padding, height. */
  className?: string;
  placement?: "center" | "top";
  children: ReactNode;
};

/**
 * A dialog over the page, drawn into <body> so no parent clips or stacks it.
 * Dialogs stack: Escape closes the topmost (the shell's key handler asks the
 * layer stack), the ones below it and the page behind go inert, so Tab stays
 * inside. Focus moves in to [data-autofocus] or the first control, and back to
 * where it was on close. In the desktop app it starts below the title bar,
 * which stays draggable.
 */
export function Modal({ onClose, labelledBy, label, className = "max-w-lg p-6", placement = "center", children }: Props) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  // What had focus before the dialog opened, read before any child takes it.
  const [opener] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));
  // Topmost, or just opening (not on the stack yet, it goes on top): only the topmost dialog is live.
  const top = useSyncExternalStore(
    subscribeLayers,
    () => {
      const layers = getLayers();
      return !layers.some((l) => l.id === id) || layers.at(-1)?.id === id;
    },
    () => true,
  );

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => pushLayer({ id, modal: true, onEscape: () => close.current() }), [id]);

  useEffect(() => {
    const box = panel.current;
    if (box && !box.contains(document.activeElement)) {
      const target = box.querySelector<HTMLElement>("[data-autofocus]") ?? box.querySelector<HTMLElement>(FOCUSABLE) ?? box;
      target.focus();
    }
    return () => restoreFocus(opener);
  }, [opener]);

  return createPortal(
    <div
      className={`modal-backdrop fixed inset-x-0 bottom-0 z-[70] flex justify-center overflow-y-auto bg-black/60 p-4 ${placement === "top" ? "items-start pt-[10vh]" : "items-center"}`}
      style={{ top: "var(--tb-h)" }}
      onMouseDown={(e) => e.target === e.currentTarget && close.current()}
      inert={!top}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        className={`modal-panel relative w-full rounded-2xl border border-line bg-panel shadow-2xl outline-none ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The ✕ in a dialog's corner. */
export function CloseButton({ onClick, label = "Close" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="-m-1 rounded-lg p-1.5 text-muted transition hover:bg-panel-3 hover:text-fg" aria-label={label} title={label}>
      <Icon name="x" size={16} />
    </button>
  );
}
