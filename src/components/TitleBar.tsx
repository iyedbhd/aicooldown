"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { desktopApp, useDesktopInfo } from "@/lib/desktop";
import { openShell } from "@/lib/ui";
import { Icon, type IconName } from "./Icon";
import { Mark } from "./Logo";

const PAGES: { href: string; label: string; icon: IconName; match: (path: string) => boolean }[] = [
  { href: "/", label: "Dashboard", icon: "gauge", match: (p) => p === "/" },
  { href: "/team", label: "Team", icon: "users", match: (p) => p.startsWith("/team") },
];

/**
 * The desktop app's title bar on Windows, drawn by the page next to the
 * system's own caption buttons (main.mjs turns on titleBarOverlay): the app,
 * its pages, the command palette and settings. Everything but the controls
 * drags the window; a double-click maximizes it, a right-click opens the
 * window menu. CSS shows it only with data-titlebar="custom" and sizes it
 * from env(titlebar-area-*).
 */
export function TitleBar({ inert }: { inert: boolean }) {
  const pathname = usePathname();
  const info = useDesktopInfo();
  const update = info?.update;

  return (
    <header className="titlebar" inert={inert}>
      <div className="flex min-w-0 items-center gap-2 pl-3">
        <Mark size={16} className="shrink-0" />
        <span className="titlebar-name truncate font-medium text-fg-2">AI Cooldown</span>
        <nav aria-label="Pages" className="ml-2 flex items-center gap-0.5">
          {PAGES.map((page) => {
            const active = page.match(pathname);
            return (
              <Link
                key={page.href}
                href={page.href}
                aria-current={active ? "page" : undefined}
                className={`titlebar-control flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-colors ${active ? "bg-panel-3 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
              >
                <Icon name={page.icon} size={13} />
                <span className="titlebar-label">{page.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <button type="button" onClick={() => openShell("palette")} className="titlebar-control titlebar-search" title="Search accounts and commands (Ctrl+K)">
        <Icon name="search" size={13} className="shrink-0" />
        <span className="titlebar-label flex-1 truncate text-left">Search or run a command</span>
        <kbd className="titlebar-label font-mono text-[10px] text-faint">Ctrl K</kbd>
      </button>

      <div className="flex min-w-0 items-center justify-end gap-1 pr-1.5">
        {update?.state === "ready" && (
          <button
            type="button"
            onClick={() => void desktopApp()?.action("install-update")}
            className="titlebar-control flex h-7 items-center gap-1.5 truncate rounded-md border border-accent/50 px-2.5 text-accent hover:bg-panel-2"
            title={`AI Cooldown ${update.version} is downloaded. Restart to use it.`}
          >
            <Icon name="download" size={13} />
            <span className="titlebar-label">Restart to update</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => openShell({ settings: "general" })}
          className="titlebar-control grid h-7 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-fg"
          aria-label="Settings"
          title="Settings (Ctrl+,)"
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </header>
  );
}
