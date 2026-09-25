"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { formatAgo } from "@/lib/format";
import type { LocalAction, LocalDevice } from "@/lib/local";
import type { SessionUser } from "@/lib/session";
import { REMOTE_HELP, REMOTE_LABEL, REMOTE_LEVELS, type RemoteLevel } from "@/lib/team";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { StatusChip } from "./TeamBits";

type Props = {
  device: LocalDevice;
  user: SessionUser | null;
  now: number;
  busy: string | null;
  run: (key: string, body: LocalAction, done?: string) => Promise<void>;
};

/**
 * This computer in the signed-in account: connecting it (so it shows on the
 * Team page with its sessions and what it works on), whether it shares what
 * its sessions say, and what remote sessions may do here. Only this computer
 * decides those two.
 */
export function DevicePanel({ device, user, now, busy, run }: Props) {
  const reconnecting = useRef(false);
  const disabled = busy !== null;
  const mine = Boolean(user && device.owner?.userId === user.id);

  // Disconnected by the account (signed out everywhere) and signed in again here: reconnect, as it was.
  useEffect(() => {
    if (!mine || device.linked || reconnecting.current) return;
    reconnecting.current = true;
    void run("connect", { action: "connect" });
  }, [mine, device.linked, run]);

  function setShare(on: boolean) {
    if (on === device.share) return;
    if (
      on &&
      !window.confirm(
        "Share what the Claude Code and Codex sessions on this computer say?\n\n" +
          "You, and the owners and admins of your teams, then see each session's title (or its first prompt) on the Team page, and can have any session's " +
          "conversation sent there: prompts, replies, the commands run and what they printed, which can include code, file contents and anything else a " +
          "session saw. A conversation is sent only when someone asks for it, and kept there a week.",
      )
    )
      return;
    void run(
      `share-${on}`,
      { action: "share", on },
      on ? "This computer shares session content now." : "Session content stays on this computer again; what it sent is deleted from the Team page.",
    );
  }

  function setLevel(level: RemoteLevel) {
    if (level === device.remote) return;
    if (level === "full" && !window.confirm("Full access lets remote sessions edit any file in a project and run any command on this computer, without asking. Allow it?")) return;
    void run(`remote-${level}`, { action: "remote", level }, level === "off" ? "Remote sessions are off on this computer." : `Remote sessions here may now: ${REMOTE_LABEL[level].toLowerCase()}.`);
  }

  return (
    <div className="mb-4 rounded-2xl border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-fg-2">
          <Icon name="monitor" size={15} />
          This computer in your account
        </span>
        {device.linked ? (
          <span className="flex items-center gap-2">
            <Link href="/team" className="btn">
              <Icon name="users" />
              Team page
            </Link>
            <button type="button" disabled={disabled} onClick={() => void run("disconnect", { action: "disconnect", forget: true }, "This computer is disconnected.")} className="btn">
              {busy === "disconnect" ? "…" : "Disconnect"}
            </button>
          </span>
        ) : (
          user && (
            <button type="button" disabled={disabled} onClick={() => void run("connect", { action: "connect" }, "Connected. It shows on the Team page in a moment.")} className="btn btn-primary">
              <Icon name="link" />
              {busy === "connect" ? "Connecting…" : "Connect this computer"}
            </button>
          )
        )}
      </header>

      <div className="space-y-3 px-4 py-3">
        {device.linked ? (
          <p className="font-mono text-[11px] text-faint">
            connected to {device.linked.email} on {device.linked.server}
            {device.lastSync ? ` · checked in ${formatAgo(now - device.lastSync)}` : " · checking in…"}
          </p>
        ) : (
          <p className="text-xs text-muted">
            {user
              ? `Connect it to ${user.email} to see this computer, its Claude Code and Codex sessions, its projects and their token usage on the Team page, next to the rest of your team, and to start sessions here from the dashboard if you allow it below.`
              : "Sign in to connect this computer to your account and your team."}
          </p>
        )}
        {device.error && <p className="text-xs text-amber-700 dark:text-amber-300">{device.error}</p>}
        <p className="text-[11px] text-faint">
          While connected it reports its name and system, the accounts its CLIs are signed in with, and each Claude Code and Codex session in the CLIs&apos; logs:
          its project folder and git branch, where it ran, its models, times and token counts. What the sessions say only if you share it below.
        </p>

        <div>
          <p className="eyebrow">session content</p>
          <div role="radiogroup" aria-label="Share session content" className="mt-1.5 inline-flex gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                role="radio"
                aria-checked={device.share === on}
                disabled={disabled}
                onClick={() => setShare(on)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition ${device.share === on ? (on ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-panel-3 text-fg") : "text-muted hover:text-fg-2"}`}
              >
                <Icon name={on ? "eye" : "lock"} size={11} />
                {on ? "Shared" : "Private"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-faint">
            {device.share
              ? "Session titles show on the Team page, and you and your teams' owners and admins can have a session's conversation sent there (prompts, replies, commands and their output). Only when asked; kept a week."
              : "Sessions show on the Team page without titles, and their conversations stay on this computer."}
          </p>
        </div>

        <div>
          <p className="eyebrow">remote sessions on this computer</p>
          <div role="radiogroup" aria-label="What remote sessions may do" className="mt-1.5 inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5">
            {REMOTE_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={device.remote === level}
                disabled={disabled}
                onClick={() => setLevel(level)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${device.remote === level ? (level === "full" ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-panel-3 text-fg") : "text-muted hover:text-fg-2"}`}
              >
                {REMOTE_LABEL[level]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-faint">
            {REMOTE_HELP[device.remote]}
            {device.remote !== "off" &&
              " You, and the owners and admins of your teams, can start them from the Team page. They run as the account the Claude Code or Codex CLI here is signed in with, and you can stop one from here."}
          </p>
        </div>

        {device.running && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <StatusChip status="running" />
            <ProviderGlyph provider={device.running.tool} size={13} />
            <span className="min-w-0 flex-1 truncate text-sm text-fg" title={device.running.prompt}>
              {device.running.prompt}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {device.running.by ?? "someone"} · {device.running.project} · {formatAgo(now - device.running.at)}
            </span>
            <button type="button" onClick={() => void run("stop-run", { action: "stop-run" }, "Stopped the remote session.")} className="btn border-rose-500/40 text-rose-600 dark:text-rose-400">
              <Icon name="stop" />
              Stop
            </button>
          </div>
        )}

        {device.recent.filter((r) => r.id !== device.running?.id).length > 0 && (
          <div>
            <p className="eyebrow">recent remote sessions here</p>
            <ul className="mt-1.5 space-y-1">
              {device.recent
                .filter((r) => r.id !== device.running?.id)
                .slice(0, 5)
                .map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs">
                    <StatusChip status={r.status} />
                    <ProviderGlyph provider={r.tool} size={12} />
                    <span className="min-w-0 flex-1 truncate text-fg-2" title={r.prompt}>
                      {r.prompt}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">
                      {r.by ?? "someone"} · {formatAgo(now - r.at)}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
