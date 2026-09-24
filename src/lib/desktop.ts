/** What the desktop app's window adds to the page (desktop/preload.cjs). */
export type DesktopBridge = {
  /** A native notification; clicking it opens the app's window, even from the tray. */
  notify(title: string, body: string, tag: string): void;
};

/** The desktop app's bridge, or undefined in a browser. Client-side only. */
export function desktopApp(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { aicooldownDesktop?: DesktopBridge }).aicooldownDesktop;
}
