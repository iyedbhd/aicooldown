"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { allCommands, useCommands, type AppCommand } from "@/lib/commands";
import { DESKTOP_BUILD, desktopApp, useDesktop, useDesktopInfo, type DesktopCommand } from "@/lib/desktop";
import { watchLocalState } from "@/lib/local-watch";
import { SITE } from "@/lib/site";
import { setThemePref, watchTheme } from "@/lib/theme";
import { closeShell, currentShell, getLayers, isEditable, openShell, subscribeLayers, toast, topLayer, useShellDialog } from "@/lib/ui";
import { engine, useUsage } from "@/lib/usage/engine";
import { desktopStatus } from "@/lib/usage/status";
import { DialogHost, Toaster } from "./Feedback";
import { TitleBar } from "./TitleBar";

const ShellDialogs = dynamic(() => import("./ShellDialogs").then((m) => m.ShellDialogs), { ssr: false });

/** How often the tray's countdowns are brought up to date, besides every change. */
const STATUS_TICK_MS = 15_000;

type Router = ReturnType<typeof useRouter>;

const hasModal = () => getLayers().some((l) => l.modal);
/** A dialog drawn by a page itself (the chat, the image viewer) rather than by the shell. */
const pageDialogOpen = () => !topLayer() && document.querySelector('[aria-modal="true"]') !== null;

/**
 * Around every page: starts the usage engine (on the dashboard, and on every
 * page in the desktop app), and holds what the whole app shares: toasts and
 * questions, the shell's dialogs, keyboard shortcuts, the command palette's
 * global commands, and in the desktop app the title bar and the link to the
 * main process (tray status, theme, commands from the tray and jump list).
 *
 * The pages sit in a frame. On the website it is invisible (display:
 * contents). Under the desktop app's own title bar it is a fixed box below
 * the bar with layout containment, so the pages' own full-window overlays
 * start below the bar too, and its scroller keeps the scrollbar clear of the
 * caption buttons.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const desktop = useDesktop();
  const dialog = useShellDialog();
  const modal = useSyncExternalStore(subscribeLayers, hasModal, () => false);
  const info = useDesktopInfo();
  const routerRef = useRef<Router>(router);

  useEffect(() => {
    routerRef.current = router;
  });

  useEffect(() => engine.attach(), []);
  useEffect(() => engine.setActive(desktop || pathname === "/"), [desktop, pathname]);
  useEffect(() => watchTheme(), []);
  // In the desktop app "This machine" is watched on every page, so remote sessions started here are announced anywhere.
  useEffect(() => (desktop ? watchLocalState() : undefined), [desktop]);
  // A new page closes whatever the shell had open.
  useEffect(() => closeShell(), [pathname]);
  // The dialogs load when first opened; fetched once the page is idle, the first Ctrl+K or tray command opens at once.
  useEffect(() => {
    const warm = () => void import("./ShellDialogs");
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(warm, 2000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(warm, { timeout: 5000 });
    return () => cancelIdleCallback(idle);
  }, []);

  // Full screen hides the caption buttons, and with them the title bar.
  useEffect(() => {
    if (info?.fullscreen) document.documentElement.dataset.fullscreen = "";
    else delete document.documentElement.dataset.fullscreen;
  }, [info?.fullscreen]);

  useKeyboard(routerRef, desktop);
  useBridge(routerRef);
  useShellCommands(routerRef, desktop, pathname);

  return (
    <>
      {DESKTOP_BUILD && <TitleBar inert={modal} />}
      <div id="aic-frame" inert={modal}>
        <div id="aic-scroll">{children}</div>
      </div>
      {dialog !== null && <ShellDialogs />}
      <DialogHost />
      <Toaster />
    </>
  );
}

/** What a page offers as "refresh" (the Team page: its workspace), or every account's usage. */
function refreshPage() {
  const own = allCommands().find((c) => c.id === "refresh");
  if (own) own.run();
  else engine.refresh();
}

async function copyStatus() {
  if (await engine.copyStatus()) toast("Status copied.");
}

function runCommand(command: DesktopCommand, router: Router) {
  if (command === "refresh") refreshPage();
  else if (command === "add-account") openShell("add");
  else if (command === "settings") openShell({ settings: "general" });
  else if (command === "palette") openShell("palette");
  else if (command === "team") router.push("/team");
  else if (command === "dashboard") router.push("/");
  else if (command === "toggle-notify") void engine.toggleNotify();
  else if (command === "copy-status") void copyStatus();
}

/**
 * One key handler for the whole app, in the capture phase and installed
 * first, so it runs before any page's: Escape closes the topmost shell dialog
 * or menu; shortcuts wait while any dialog is open. Browsers keep Ctrl+R,
 * Ctrl+N and Ctrl+1 for themselves, so those are the desktop app's only.
 */
function useKeyboard(router: React.RefObject<Router>, desktop: boolean) {
  const desktopRef = useRef(desktop);
  useEffect(() => {
    desktopRef.current = desktop;
  });

  useEffect(() => {
    const mac = /mac/i.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      // A control recording keys (the shortcut recorder in Settings) gets them all.
      if (e.target instanceof Element && e.target.closest("[data-own-keys]")) return;
      const top = topLayer();
      if (top && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        top.onEscape();
        return;
      }
      if (e.altKey || e.repeat) return; // AltGr types characters as Ctrl+Alt
      const mod = mac ? e.metaKey : e.ctrlKey;
      const plain = !e.ctrlKey && !e.metaKey;
      const shortcut = (run: () => void) => {
        e.preventDefault();
        run();
      };

      if (mod && !e.shiftKey && e.code === "KeyK") {
        if (currentShell() === "palette") return shortcut(closeShell);
        if (!top && !pageDialogOpen()) return shortcut(() => openShell("palette"));
        return;
      }
      if (top || pageDialogOpen()) return;
      if (mod && !e.shiftKey && e.code === "Comma") return shortcut(() => openShell({ settings: desktopRef.current ? "general" : "appearance" }));
      if (plain && e.key === "?" && !isEditable(e.target)) return shortcut(() => openShell({ settings: "shortcuts" }));

      if (!desktopRef.current) return;
      if ((mod && !e.shiftKey && e.code === "KeyR") || (plain && !e.shiftKey && e.key === "F5")) return shortcut(refreshPage);
      if (mod && !e.shiftKey && e.code === "KeyN") return shortcut(() => openShell("add"));
      if (mod && e.shiftKey && e.code === "KeyC") return shortcut(() => void copyStatus());
      if (mod && !e.shiftKey && e.code === "Digit1") return shortcut(() => router.current.push("/"));
      if (mod && !e.shiftKey && e.code === "Digit2") return shortcut(() => router.current.push("/team"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router]);
}

/** The desktop app's main process: commands from the tray, jump list and menus in; tray and taskbar status out. */
function useBridge(router: React.RefObject<Router>) {
  useEffect(() => {
    const bridge = desktopApp();
    if (!bridge) return;
    const offCommands = bridge.onCommand((command) => {
      // A dialog a page drew itself (the chat) stays in charge; the shell's own dialogs give way.
      if (pageDialogOpen()) return;
      runCommand(command, router.current);
    });

    let last = "";
    const push = () => {
      const status = desktopStatus(engine.getSnapshot(), Date.now());
      const key = JSON.stringify(status);
      if (key === last) return;
      last = key;
      bridge.setStatus(status);
    };
    push();
    const offEngine = engine.subscribe(push);
    const tick = setInterval(push, STATUS_TICK_MS);
    return () => {
      offCommands();
      offEngine();
      clearInterval(tick);
    };
  }, [router]);
}

/** What the palette offers on every page. Account commands only where the engine runs, so the website offers none off the dashboard. */
function useShellCommands(router: React.RefObject<Router>, desktop: boolean, pathname: string) {
  const accounts = useUsage((s) => s.accounts);
  const user = useUsage((s) => s.user);
  const notify = useUsage((s) => s.notify);
  const info = useDesktopInfo();

  useCommands("shell", () => {
    const go = (path: string) => () => router.current.push(path);
    const list: AppCommand[] = [
      { id: "go-dashboard", title: "Go to the dashboard", group: "Go to", icon: "gauge", shortcut: desktop ? "Ctrl+1" : undefined, keywords: "limits home", run: go("/") },
      { id: "go-team", title: "Go to Team", group: "Go to", icon: "users", shortcut: desktop ? "Ctrl+2" : undefined, keywords: "people computers sessions projects", run: go("/team") },
      { id: "settings", title: "Settings", group: "App", icon: "settings", shortcut: "Ctrl+,", keywords: "preferences options", run: () => openShell({ settings: desktop ? "general" : "appearance" }) },
      { id: "shortcuts", title: "Keyboard shortcuts", group: "App", icon: "keyboard", shortcut: "?", keywords: "keys help", run: () => openShell({ settings: "shortcuts" }) },
      { id: "theme-system", title: "Theme: follow the system", group: "App", icon: "palette", keywords: "appearance auto", run: () => setThemePref("system") },
      { id: "theme-light", title: "Theme: light", group: "App", icon: "sun", keywords: "appearance", run: () => setThemePref("light") },
      { id: "theme-dark", title: "Theme: dark", group: "App", icon: "moon", keywords: "appearance", run: () => setThemePref("dark") },
      { id: "about", title: `About ${SITE.name}`, group: "App", icon: "info", keywords: "version help", run: () => openShell({ settings: "about" }) },
    ];

    if (desktop || pathname === "/") {
      list.push(
        { id: "add-account", title: "Add an account", group: "Accounts", icon: "plus", shortcut: desktop ? "Ctrl+N" : undefined, keywords: "claude codex chatgpt connect link", run: () => openShell("add") },
        { id: "refresh-accounts", title: "Refresh every account", group: "Accounts", icon: "refresh", shortcut: desktop && pathname === "/" ? "Ctrl+R" : undefined, keywords: "reload usage poll", run: () => engine.refresh() },
        { id: "copy-status", title: "Copy the status of every account", group: "Accounts", icon: "copy", shortcut: desktop ? "Ctrl+Shift+C" : undefined, keywords: "share clipboard", run: () => void copyStatus() },
        {
          id: "notify",
          title: notify ? "Turn notifications off" : "Turn notifications on",
          group: "Accounts",
          icon: notify ? "bellOff" : "bell",
          keywords: "alerts notify",
          run: () => void engine.toggleNotify(),
        },
      );
      for (const a of accounts) {
        const name = a.provider === "claude" ? "Claude" : "Codex";
        list.push(
          { id: `refresh:${a.id}`, title: `Refresh ${a.label}`, group: "Accounts", icon: "refresh", keywords: `${name} ${a.plan ?? ""}`, run: () => engine.refresh(a.id) },
          { id: `copy:${a.id}`, title: `Copy the status of ${a.label}`, group: "Accounts", icon: "copy", keywords: name, run: () => void engine.copyStatus(a.id) },
        );
      }
      if (user) {
        list.push(
          { id: "account", title: "Your AI Cooldown account", group: "Accounts", icon: "user", keywords: `${user.email} password devices delete`, run: () => openShell("account") },
          { id: "sign-out", title: `Sign out of ${user.email}`, group: "Accounts", icon: "logout", keywords: "log out", run: () => void engine.signOut() },
        );
      } else {
        list.push({ id: "sign-in", title: "Sign in to sync your accounts", group: "Accounts", icon: "user", keywords: "log in register create account", run: () => openShell("auth") });
      }
    }

    const bridge = desktopApp();
    if (bridge && info) {
      list.push(
        { id: "check-updates", title: info.update.state === "ready" ? `Restart to update to ${info.update.version}` : "Check for updates", group: "App", icon: "download", keywords: "version upgrade", run: () => void bridge.action(info.update.state === "ready" ? "install-update" : "check-updates") },
        { id: "data-folder", title: "Open the data folder", group: "App", icon: "folder", keywords: "files logs", run: () => void bridge.action("open-data-folder") },
        { id: "quit", title: `Quit ${SITE.name}`, group: "App", icon: "logout", shortcut: "Ctrl+Q", keywords: "exit close", run: () => void bridge.action("quit") },
      );
    }
    list.push({ id: "report", title: "Report a problem", group: "Help", icon: "external", keywords: "bug issue github feedback", run: () => window.open(`${SITE.repo}/issues/new`, "_blank", "noopener") });
    return list;
  });
}
