import { useSyncExternalStore } from "react";

/** Where an update stands: idle, checking, downloading, ready (downloaded, Windows and Linux) or available (macOS). */
export type UpdateState = { state: "idle" | "checking" | "downloading" | "ready" | "available"; version?: string; checkedAt?: number; error?: string };

/** What the app's main process decides, as Settings shows it. */
export type DesktopSettings = {
  /** Starts at sign-in, in the tray. Only an installed copy can. */
  openAtLogin: boolean;
  /** Closing the window keeps the app in the tray; false quits it. */
  closeToTray: boolean;
  /** A global accelerator that shows or hides the window, e.g. "Ctrl+Alt+A"; null for none. */
  shortcut: string | null;
};

export type DesktopInfo = {
  version: string;
  platform: string;
  /** Installed the usual way rather than run from a build folder: only then does it open at login and update itself. */
  installed: boolean;
  /** Where the app keeps its data. */
  dataFolder: string;
  settings: DesktopSettings;
  update: UpdateState;
  fullscreen: boolean;
};

/** Where the tray and the taskbar stand: the worst of the providers' verdicts, one line per provider. */
export type DesktopStatus = { level: "none" | "unknown" | "go" | "tight" | "wait"; lines: string[]; tooltip: string; notify: boolean };

/** What main asks the page to do: from the tray, the jump list, a second start or the macOS menu. */
export type DesktopCommand = "refresh" | "add-account" | "settings" | "team" | "dashboard" | "toggle-notify" | "palette" | "copy-status";

export type CodexCallback = { url: string } | { status: "busy" | "timeout" | "cancelled" | "unavailable" };

/** What the desktop app's window adds to the page (desktop/preload.cjs). */
export type DesktopBridge = {
  platform: string;
  /** Height of the title bar the page draws (Windows), or 0 where the system draws its own. */
  titleBarHeight: number;
  /** A native notification; clicking it opens the app's window, even from the tray. */
  notify(title: string, body: string, tag: string): void;
  getInfo(): Promise<DesktopInfo | null>;
  onInfo(callback: (info: DesktopInfo) => void): () => void;
  setSetting<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): Promise<{ ok: boolean; error?: string } | null>;
  action(name: "check-updates" | "install-update" | "open-data-folder" | "quit"): Promise<unknown>;
  setStatus(status: DesktopStatus): void;
  setTheme(theme: "light" | "dark", explicit: boolean): void;
  /** Subscribes to commands; main holds them until the first subscriber. */
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  /** Waits for the Codex sign-in to come back to localhost:1455 with this state. */
  codexCallback(state: string): Promise<CodexCallback | null>;
  cancelCodexCallback(): void;
};

/** The desktop app's bridge, or undefined in a browser. Client-side only. */
export function desktopApp(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { aicooldownDesktop?: DesktopBridge }).aicooldownDesktop;
}

/** Built into the desktop app (npm run desktop): only that build carries its title bar. */
export const DESKTOP_BUILD = process.env.NEXT_PUBLIC_AICOOLDOWN_DESKTOP === "1";

const noSubscription = () => () => {};

/** Whether the page runs in the desktop app's window: false on the server and in browsers. */
export function useDesktop(): boolean {
  return useSyncExternalStore(noSubscription, () => Boolean(desktopApp()), () => false);
}

// ---- What main says about the app (version, settings, updates), kept up to date.

let info: DesktopInfo | null = null;
const infoListeners = new Set<() => void>();
let infoStarted = false;

function setInfo(next: DesktopInfo | null) {
  info = next;
  for (const l of infoListeners) l();
}

function subscribeInfo(listener: () => void) {
  infoListeners.add(listener);
  const bridge = desktopApp();
  if (bridge && !infoStarted) {
    infoStarted = true;
    bridge.onInfo(setInfo);
    void bridge.getInfo().then((first) => first && setInfo(first));
  }
  return () => {
    infoListeners.delete(listener);
  };
}

/** The desktop app's info, or null in a browser and until main answers. */
export function useDesktopInfo(): DesktopInfo | null {
  return useSyncExternalStore(
    subscribeInfo,
    () => info,
    () => null,
  );
}
