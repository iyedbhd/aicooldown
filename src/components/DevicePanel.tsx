"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatAgo } from "@/lib/format";
import type { LocalAction, LocalDevice, LocalState } from "@/lib/local";
import type { SessionUser } from "@/lib/session";
import { REMOTE_HELP, REMOTE_LABEL, REMOTE_LEVELS, SHARE_HELP, SHARE_LABEL, SHARE_LEVELS, TOOL_NAME, type RemoteLevel, type ShareLevel } from "@/lib/team";
import { confirmAction, copyText } from "@/lib/ui";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";
import { StatusChip } from "./TeamBits";

type Props = {
  device: LocalDevice;
  /** Whether each CLI can run remote sessions here, and how to sign it in. */
  tools: LocalState["tools"];
  user: SessionUser | null;
  now: number;
  busy: string | null;
  run: (key: string, body: LocalAction, done?: string) => Promise<void>;
};

/**
 * This computer in the signed-in account: connecting it (so it shows on the
 * Team page with its sessions and what it works on), whether what its
 * sessions say reaches the website, and what remote sessions may do here.
 * This computer decides those two, except that a team member's lets what
 * sessions say through: their teams' owners and admins see all of their work.
 */
export function DevicePanel({ device, tools, user, now, busy, run }: Props) {
  const reconnecting = useRef(false);
  const disabled = busy !== null;
  const mine = Boolean(user && device.owner?.userId === user.id);

  // Disconnected by the account (signed out everywhere) and signed in again here: reconnect, as it was.
  useEffect(() => {
    if (!mine || device.linked || reconnecting.current) return;
    reconnecting.current = true;
    void run("connect", { action: "connect" });
  }, [mine, device.linked, run]);

  async function setShare(level: ShareLevel) {
    if (level === device.share) return;
    if (
      level === "on" &&
      !(await confirmAction({
        title: "Let what this computer's sessions say reach the website?",
        body:
          "Signed in as you, you then see each session's title (or its first prompt) on the Team page, and can have any session's conversation sent there, " +
          "and continue it: prompts, replies, the commands run and what they printed, which can include code, file contents and anything else a session saw. " +
          "A conversation is sent only when asked for, and kept there a week.\n\nThe people in your teams see it only for the projects and chats you share with them on the Team page.",
        confirmLabel: "Let it reach the website",
        danger: true,
      }))
    )
      return;
    void run(
      `share-${level}`,
      { action: "share", level },
      level === "off" ? "What sessions say stays on this computer again; what it sent is deleted from the Team page." : "What this computer's sessions say reaches the website now.",
    );
  }
  const managedBy = device.sharing?.managedBy ?? [];

  async function setLevel(level: RemoteLevel) {
    if (level === device.remote) return;
    if (
      level === "full" &&
      !(await confirmAction({
        title: "Allow full access?",
        body: "Full access lets remote sessions edit any file in a project and run any command on this computer, without asking.",
        confirmLabel: "Allow full access",
        danger: true,
      }))
    )
      return;
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
          its project folder and git branch, where it ran, its models, times and token counts. What the sessions say only if you let it below.
        </p>

        <div>
          <p className="eyebrow">session content</p>
          {managedBy.length > 0 ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <Icon name="eye" size={12} className="mt-px shrink-0" />
              <span>
                You are a member of {managedBy.join(", ")}: {managedBy.length === 1 ? "its" : "their"} owner and admins see all your work here, what your sessions say
                included, and can continue those sessions where remote sessions are allowed below. That goes with being a member; leaving the team, or becoming one
                of its admins, gives you the choice again.
              </span>
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Whether what sessions say reaches the website" className="mt-1.5 inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5">
                {SHARE_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={device.share === level}
                    disabled={disabled}
                    onClick={() => void setShare(level)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition ${device.share === level ? "bg-panel-3 text-fg" : "text-muted hover:text-fg-2"}`}
                  >
                    <Icon name={level === "off" ? "lock" : "eye"} size={11} />
                    {SHARE_LABEL[level]}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-faint">{SHARE_HELP[device.share]} Continuing a conversation from the website also needs remote sessions allowed below.</p>
            </>
          )}
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
                onClick={() => void setLevel(level)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${device.remote === level ? (level === "full" ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-panel-3 text-fg") : "text-muted hover:text-fg-2"}`}
              >
                {REMOTE_LABEL[level]}
              </button>
            ))}
          </div>
          {device.remote !== "off" && <SignInHints tools={tools} />}
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

/** A CLI that cannot run remote sessions here, and how to fix that: sign it in once, in a terminal on this computer. */
function SignInHints({ tools }: { tools: LocalState["tools"] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const waiting = (["claude", "codex"] as const).filter((p) => tools[p].state !== "ready");
  if (waiting.length === 0) return null;
  async function copy(command: string) {
    if (await copyText(command, "Copy this command")) setCopied(command);
  }
  return (
    <div className="mt-2 space-y-1.5">
      {waiting.map((p) => (
        <div key={p} className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-fg-2">
          <p className="flex items-center gap-1.5">
            <ProviderGlyph provider={p} size={12} />
            {tools[p].state === "missing"
              ? `${TOOL_NAME[p]} is not installed here, so remote ${TOOL_NAME[p]} sessions cannot run. Install its CLI or desktop app.`
              : `${TOOL_NAME[p]} is not signed in for remote sessions here (the desktop app's own sign-in does not count). Sign it in once, in a terminal on this computer:`}
          </p>
          {tools[p].state === "signed-out" && (
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-panel-2 px-2 py-1 font-mono text-[11px] text-fg">{tools[p].signIn}</code>
              <button type="button" onClick={() => void copy(tools[p].signIn)} className="btn">
                <Icon name={copied === tools[p].signIn ? "check" : "copy"} />
                {copied === tools[p].signIn ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
