"use client";

import { useEffect, useId, useState } from "react";
import { answerDialog, closeToast, useDialogs, useToasts, type PendingDialog, type Toast } from "@/lib/ui";
import { Icon } from "./Icon";
import { CloseButton, Modal } from "./Modal";

/** Toasts, bottom right, above dialogs. Hovering one, or focusing its buttons, holds it. */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toaster pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[min(24rem,calc(100vw-2rem))] flex-col items-end gap-2" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastItem({ item }: { item: Toast }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (item.duration === null || held) return;
    const timer = setTimeout(() => closeToast(item.id, "timeout"), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, held]);

  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="toast pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-line bg-panel py-2.5 pr-2.5 pl-4 text-sm text-fg-2 shadow-lg"
    >
      {item.tone === "error" && <Icon name="info" size={15} className="mt-0.5 shrink-0 text-rose-500" />}
      <p className="min-w-0 flex-1 py-0.5 break-words">{item.text}</p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action!.run();
            closeToast(item.id, "action");
          }}
          className="shrink-0 rounded-lg px-2 py-0.5 font-medium text-accent hover:bg-panel-3"
        >
          {item.action.label}
        </button>
      )}
      <button type="button" onClick={() => closeToast(item.id, "dismiss")} className="shrink-0 rounded-lg p-1 text-faint hover:bg-panel-3 hover:text-fg" aria-label="Dismiss">
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/** Questions asked with confirmAction() and text copyText() could not copy, one at a time. */
export function DialogHost() {
  const dialogs = useDialogs();
  const entry = dialogs[0];
  if (!entry) return null;
  return entry.kind === "confirm" ? <ConfirmDialog key={entry.id} entry={entry} /> : <CopyDialog key={entry.id} entry={entry} />;
}

function ConfirmDialog({ entry }: { entry: Extract<PendingDialog, { kind: "confirm" }> }) {
  const titleId = useId();
  const { request } = entry;
  return (
    <Modal onClose={() => answerDialog(entry, false)} labelledBy={titleId} className="max-w-md p-6">
      <h2 id={titleId} className="text-base font-semibold text-fg">
        {request.title}
      </h2>
      {request.body && <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-muted">{request.body}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={() => answerDialog(entry, false)} className="btn" data-autofocus={request.danger ? true : undefined}>
          {request.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          onClick={() => answerDialog(entry, true)}
          className={`btn ${request.danger ? "btn-danger" : "btn-primary"}`}
          data-autofocus={request.danger ? undefined : true}
        >
          {request.confirmLabel ?? "OK"}
        </button>
      </div>
    </Modal>
  );
}

function CopyDialog({ entry }: { entry: Extract<PendingDialog, { kind: "copy" }> }) {
  const titleId = useId();
  return (
    <Modal onClose={() => answerDialog(entry)} labelledBy={titleId} className="max-w-lg p-6">
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="text-base font-semibold text-fg">
          {entry.title}
        </h2>
        <CloseButton onClick={() => answerDialog(entry)} />
      </div>
      <p className="mt-1 text-xs text-muted">Copying was not allowed here. It is selected: press Ctrl+C (⌘C on a Mac).</p>
      <textarea
        readOnly
        data-autofocus
        value={entry.text}
        onFocus={(e) => e.currentTarget.select()}
        rows={Math.min(10, entry.text.split("\n").length + 1)}
        className="mt-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg focus:border-muted focus:outline-none"
      />
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => answerDialog(entry)} className="btn btn-primary">
          Done
        </button>
      </div>
    </Modal>
  );
}
