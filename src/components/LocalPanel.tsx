"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAgo, formatCountdown, formatDateTime, formatPlan } from "@/lib/format";
import { localAction, type CliProfile, type LocalAction, type LocalState, type ScheduleMode } from "@/lib/local";
import { reloadLocalState, showLocalState, useLocalState, watchLocalState } from "@/lib/local-watch";
import type { SessionUser } from "@/lib/session";
import type { Provider } from "@/lib/types";
import { confirmAction, toast } from "@/lib/ui";
import { DesktopApp } from "./DesktopApp";
import { DevicePanel } from "./DevicePanel";
import { Icon } from "./Icon";
import { ProviderGlyph } from "./ProviderLogo";

const CLI_NAME: Record<Provider, string> = { claude: "Claude Code CLI", codex: "Codex CLI" };
const NOT_SIGNED_IN: Record<Provider, string> = {
  claude:
    "The Claude Code CLI is not signed in on this machine. Claude Code in the Claude desktop app uses the app's own sign-in, which can't be saved or switched here. Run `claude auth login` in a terminal to sign the CLI in.",
  codex: "The Codex CLI is not signed in on this machine. Run `codex login` in a terminal to sign it in.",
};
const LOGIN_HINT: Record<Provider, string> = {
  claude: "To add another account, run `claude auth login` in a terminal with it, then save it here. Do not log out first: that can revoke the saved login.",
  codex: "To add another account, run `codex login` with it, then save it here. Do not `codex logout` first: that can revoke the saved login.",
};
const MODE_LABEL: Record<ScheduleMode, string> = { reset: "at next reset", "every-reset": "after every reset", at: "at a time" };

/** A `datetime-local` value one hour from now, in local time. */
function inAnHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * "This machine": only rendered when the server runs on the user's computer.
 * Switches which saved login each CLI uses, and says hello through the CLI to
 * start a login's 5-hour window now or on a schedule.
 */
export function LocalPanel({ now, user }: { now: number; user: SessionUser | null }) {
  /** undefined until the first answer, null when this copy does not run on the user's computer. */
  const state = useLocalState();
  const [busy, setBusy] = useState<string | null>(null);

  // Scheduled hellos and remote sessions run on the server; this picks up their results (lib/local-watch.ts). Nothing is polled on the website.
  useEffect(() => watchLocalState(), []);

  const run = useCallback(async (key: string, body: LocalAction, done?: string) => {
    setBusy(key);
    const res = await localAction(body);
    setBusy(null);
    if (res.ok) {
      showLocalState(res.data);
      if (done) toast(done);
    } else {
      toast(res.error, { tone: "error" });
      void reloadLocalState();
    }
  }, []);

  if (state === undefined) return null;
  if (state === null) return <DesktopApp />;

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-medium text-muted">This machine</h2>
      <p className="mb-3 text-xs text-faint">
        Only in a copy running on your computer. Connect it to your account and team, switch the login the Claude Code and Codex CLIs use in your terminal, or
        say hello to start a 5-hour window now so it resets sooner.
      </p>
      <DevicePanel device={state.device} tools={state.tools} user={user} now={now} busy={busy} run={run} />
      <div className="grid gap-4 md:grid-cols-2">
        {(["claude", "codex"] as const).map((provider) => {
          const live = state.live[provider];
          const signedIn = live && "label" in live ? live : null;
          const problem = live && "error" in live ? live.error : null;
          const profiles = state.profiles.filter((p) => p.provider === provider);
          return (
            <div key={provider} className="rounded-2xl border border-line bg-panel">
              <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <span className="flex items-center gap-2 text-sm font-medium text-fg-2">
                  <ProviderGlyph provider={provider} size={16} />
                  {CLI_NAME[provider]}
                </span>
                {signedIn && !signedIn.saved && (
                  <button type="button" disabled={busy !== null} onClick={() => void run(`save-${provider}`, { action: "save", provider }, `Saved ${signedIn.label}.`)} className="btn">
                    <Icon name="plus" />
                    {busy === `save-${provider}` ? "…" : "Save current login"}
                  </button>
                )}
              </header>
              {signedIn ? (
                <p className="px-4 pt-3 font-mono text-[11px] text-faint">signed in as {signedIn.label}</p>
              ) : (
                <p className={`px-4 pt-3 text-xs ${problem ? "text-rose-600 dark:text-rose-400" : "text-muted"}`}>{problem ?? NOT_SIGNED_IN[provider]}</p>
              )}
              <ul className="divide-y divide-line px-4">
                {profiles.map((p) => (
                  <ProfileRow key={p.id} profile={p} state={state} now={now} busy={busy} run={run} />
                ))}
              </ul>
              {profiles.length === 0 && <p className="px-4 py-3 text-xs text-muted">No saved logins yet.</p>}
              <p className="border-t border-line px-4 py-2 text-[11px] text-faint">{LOGIN_HINT[provider]}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type RowProps = {
  profile: CliProfile;
  state: LocalState;
  now: number;
  busy: string | null;
  run: (key: string, body: LocalAction, done?: string) => Promise<void>;
};

function ProfileRow({ profile: p, state, now, busy, run }: RowProps) {
  const [mode, setMode] = useState<ScheduleMode>("reset");
  const [at, setAt] = useState(inAnHour);
  const schedules = state.schedules.filter((s) => s.profileId === p.id).sort((a, b) => a.at - b.at);
  const last = state.runs[p.id];
  const plan = formatPlan(p.plan);
  const disabled = busy !== null;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {p.label}
          {plan && <span className="ml-2 rounded-md bg-panel-3 px-1.5 py-px text-xs font-medium text-fg-2">{plan}</span>}
        </span>
        {p.active ? (
          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">in use</span>
        ) : (
          <button type="button" disabled={disabled} onClick={() => void run(`switch-${p.id}`, { action: "switch", profileId: p.id }, `The CLI now uses ${p.label}. Restart running sessions to pick it up.`)} className="btn" title="Make this the login the CLI uses">
            {busy === `switch-${p.id}` ? "…" : "Switch to"}
          </button>
        )}
        <button type="button" disabled={disabled} onClick={() => void run(`hello-${p.id}`, { action: "hello", profileId: p.id }, `Said hello as ${p.label}. Its 5-hour window is running.`)} className="btn" title={'Send "hello" through the CLI as this login'}>
          <Icon name={busy === `hello-${p.id}` ? "refresh" : "flame"} className={busy === `hello-${p.id}` ? "spin" : undefined} />
          {busy === `hello-${p.id}` ? "Sending…" : "Say hello"}
        </button>
        <button
          type="button"
          disabled={disabled || p.active}
          onClick={async () => {
            const ok = await confirmAction({
              title: `Forget ${p.label}?`,
              body: "The copy of this login saved on this computer is deleted, with its schedules. The account itself is not touched: sign the CLI in with it and save it again to bring it back.",
              confirmLabel: "Forget it",
              danger: true,
            });
            if (ok) void run(`forget-${p.id}`, { action: "forget", profileId: p.id }, `Forgot ${p.label}.`);
          }}
          className="rounded-lg p-1.5 text-muted transition hover:bg-rose-500/15 hover:text-rose-500 disabled:opacity-30"
          aria-label="Forget saved login"
          title={p.active ? "Switch to another login first" : "Forget this saved login"}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>

      {last && (
        <p className={`mt-1 truncate font-mono text-[11px] ${last.ok ? "text-faint" : "text-rose-600 dark:text-rose-400"}`} title={last.message}>
          {last.scheduled ? "scheduled hello" : "hello"} {formatAgo(now - last.at)} · {last.ok ? "window started" : last.message}
        </p>
      )}

      {schedules.map((s) => (
        <p key={s.id} className="mt-1 flex items-center justify-between gap-2 font-mono text-[11px] text-fg-2">
          <span className="flex items-center gap-1.5">
            <Icon name="clock" size={12} />
            {MODE_LABEL[s.mode]} · {formatDateTime(new Date(s.at).toISOString(), now)} ({s.at > now ? `in ${formatCountdown(s.at - now)}` : "sending"})
          </span>
          <button type="button" disabled={disabled} onClick={() => void run(`cancel-${s.id}`, { action: "cancel", scheduleId: s.id })} className="text-faint hover:text-rose-500">
            cancel
          </button>
        </p>
      ))}

      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`schedule-${p.id}`, { action: "schedule", profileId: p.id, mode, at: mode === "at" ? new Date(at).getTime() : undefined }, "Hello scheduled.");
        }}
      >
        <select value={mode} onChange={(e) => setMode(e.target.value as ScheduleMode)} aria-label="When to say hello" className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-xs text-fg">
          <option value="reset">Say hello at next reset</option>
          <option value="every-reset">Say hello after every reset</option>
          <option value="at">Say hello at…</option>
        </select>
        {mode === "at" && (
          <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} aria-label="Time" className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-xs text-fg" />
        )}
        <button type="submit" disabled={disabled} className="btn">
          {busy === `schedule-${p.id}` ? "…" : "Schedule"}
        </button>
      </form>
    </li>
  );
}
