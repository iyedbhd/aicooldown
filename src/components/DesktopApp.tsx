"use client";

import { useSyncExternalStore } from "react";
import { SITE } from "@/lib/site";
import { Icon } from "./Icon";

type Os = "windows" | "macos" | "linux";

/** As the release workflow names them; /releases/latest/download/<file> always serves the newest. */
const DOWNLOADS: { os: Os; label: string; file: string }[] = [
  { os: "windows", label: "Windows", file: "aicooldown-windows-x64.exe" },
  { os: "macos", label: "macOS (Apple Silicon)", file: "aicooldown-macos-arm64.dmg" },
  { os: "macos", label: "macOS (Intel)", file: "aicooldown-macos-x64.dmg" },
  { os: "linux", label: "Linux", file: "aicooldown-linux-x64.AppImage" },
];

const download = (file: string) => `${SITE.repo}/releases/latest/download/${file}`;
const link = "text-fg-2 underline-offset-2 hover:text-fg hover:underline";

/** The visitor's desktop system, or null on phones and tablets, which the app does not run on. */
function detectOs(): Os | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  if (nav.userAgentData?.mobile || /android|iphone|ipad/i.test(navigator.userAgent)) return null;
  const platform = (nav.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (platform.includes("win")) return "windows";
  // iPads say they are Macs; Macs have no touch screen.
  if (platform.includes("mac")) return navigator.maxTouchPoints > 1 ? null : "macos";
  if (platform.includes("linux")) return "linux";
  return null;
}

const noSubscription = () => () => {};

/** Shown where "This machine" would be, on a copy that does not run on the visitor's computer. */
export function DesktopApp() {
  const os = useSyncExternalStore(noSubscription, detectOs, () => null);
  const primary = DOWNLOADS.find((d) => d.os === os);
  const others = DOWNLOADS.filter((d) => d !== primary);

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-medium text-muted">Desktop app</h2>
      <p className="mb-3 text-xs text-faint">
        This dashboard as an app on your own computer, in its own window, plus what a website cannot do: switch which account the Claude Code and Codex
        CLIs are logged in with, say hello on a schedule so a 5-hour window starts before you need it, and connect the computer to your team, so what it
        works on shows on the Team page and, if you allow it, Claude Code or Codex sessions can be started on it from there. Your {SITE.name} account works there too.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-panel px-4 py-3">
        {primary && (
          <a href={download(primary.file)} className="btn btn-primary">
            <Icon name="download" />
            Download for {primary.label}
          </a>
        )}
        <span className="text-xs text-muted">
          {primary ? "Also for " : "For "}
          {others.map((d, i) => (
            <span key={d.file}>
              {i === 0 ? "" : i === others.length - 1 ? " and " : ", "}
              <a href={download(d.file)} className={link}>
                {d.label}
              </a>
            </span>
          ))}
          . Free and open source; the files are not code-signed, so{" "}
          <a href={`${SITE.repo}#desktop-app`} target="_blank" rel="noopener noreferrer" className={link}>
            here is how to run them
          </a>
          .
        </span>
      </div>
    </section>
  );
}
