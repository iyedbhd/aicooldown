import { useSyncExternalStore } from "react";

/*
 * The app shell's own state, kept outside React so any code can raise a toast,
 * ask a question or open a dialog, and so hosts mounted once in the layout
 * (components/AppShell.tsx) show them on every page.
 */

/** A value, and the functions that read and change it. */
function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get,
    subscribe,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, get, () => initial),
  };
}

// ---- Toasts: short notes in the corner, some with an action such as Undo.

export type ToastCloseReason = "timeout" | "action" | "dismiss";

export type Toast = {
  id: number;
  text: string;
  tone: "info" | "error";
  /** How long it stays, in ms; null keeps it until it is dismissed. */
  duration: number | null;
  action?: { label: string; run: () => void };
  /** Called once, however it goes: timed out, its action taken, or dismissed. */
  onClose?: (why: ToastCloseReason) => void;
};

const MAX_TOASTS = 4;
const toasts = createStore<Toast[]>([]);
let nextToast = 1;

export function toast(text: string, options: Partial<Pick<Toast, "tone" | "duration" | "action" | "onClose">> = {}): number {
  const item: Toast = {
    id: nextToast++,
    text,
    tone: options.tone ?? "info",
    duration: options.duration === undefined ? (options.action ? 8000 : 6000) : options.duration,
    action: options.action,
    onClose: options.onClose,
  };
  // The same plain note again replaces the old one rather than stacking up.
  const list = toasts.get().filter((t) => t.action || t.onClose || t.text !== text);
  list.push(item);
  const dropped = list.splice(0, Math.max(0, list.length - MAX_TOASTS));
  toasts.set(list);
  for (const t of dropped) t.onClose?.("timeout");
  return item.id;
}

export function closeToast(id: number, why: ToastCloseReason): void {
  const item = toasts.get().find((t) => t.id === id);
  if (!item) return;
  toasts.set(toasts.get().filter((t) => t.id !== id));
  item.onClose?.(why);
}

export const useToasts = toasts.use;

// ---- Questions and copy fallbacks, answered in the app's own dialogs instead of the browser's.

export type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** The confirm button warns: something is removed or exposed. */
  danger?: boolean;
};

export type PendingDialog =
  | { id: number; kind: "confirm"; request: ConfirmRequest; resolve: (ok: boolean) => void }
  | { id: number; kind: "copy"; title: string; text: string };

const dialogs = createStore<PendingDialog[]>([]);
let nextDialog = 1;

/** Asks in a dialog; resolves true only when the confirm button is pressed. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => dialogs.set([...dialogs.get(), { id: nextDialog++, kind: "confirm", request, resolve }]));
}

export function answerDialog(entry: PendingDialog, ok = false): void {
  dialogs.set(dialogs.get().filter((d) => d !== entry));
  if (entry.kind === "confirm") entry.resolve(ok);
}

/** Copies to the clipboard; where that is refused, shows the text selected in a dialog to copy by hand. */
export async function copyText(text: string, title = "Copy this"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    dialogs.set([...dialogs.get(), { id: nextDialog++, kind: "copy", title, text }]);
    return false;
  }
}

export const useDialogs = dialogs.use;

// ---- The shell's own dialogs: one at a time, reachable from anywhere (shortcuts, the palette, the tray).

export type SettingsSection = "general" | "appearance" | "notifications" | "shortcuts" | "about";
export type ShellDialog = null | "palette" | "add" | "auth" | "account" | { settings: SettingsSection };

const shell = createStore<ShellDialog>(null);

export const openShell = (dialog: ShellDialog) => shell.set(dialog);
export const closeShell = () => shell.set(null);
export const currentShell = shell.get;
export const useShellDialog = shell.use;

// ---- Layers: open dialogs and menus, topmost last. Escape closes the topmost; modal ones make the page behind inert.

export type Layer = { id: string; modal: boolean; onEscape: () => void };

const layers = createStore<Layer[]>([]);

export function pushLayer(layer: Layer): () => void {
  layers.set([...layers.get().filter((l) => l.id !== layer.id), layer]);
  return () => layers.set(layers.get().filter((l) => l.id !== layer.id));
}

export const topLayer = (): Layer | undefined => layers.get().at(-1);
export const subscribeLayers = layers.subscribe;
export const getLayers = layers.get;
export const useLayers = layers.use;

/** Whether an element takes typing, where single-key shortcuts must not fire. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const noSubscription = () => () => {};

/** The key shortcuts are written with: ⌘ on a Mac, Ctrl elsewhere (and on the server). */
export function useModKey(): string {
  return useSyncExternalStore(
    noSubscription,
    () => (/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}
