"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useDesktop } from "@/lib/desktop";
import { formatAgo, formatCountdown } from "@/lib/format";
import { SITE } from "@/lib/site";
import { rankAccounts, upcomingResets } from "@/lib/stats";
import type { Usage } from "@/lib/types";
import { openShell, useModKey } from "@/lib/ui";
import { engine, useUsage } from "@/lib/usage/engine";
import { AccountCard } from "./AccountCard";
import { CommandPanel } from "./CommandPanel";
import { Icon } from "./Icon";
import { LocalPanel } from "./LocalPanel";
import { Mark, Wordmark } from "./Logo";
import { MySessions } from "./MySessions";
import { Overview } from "./Overview";
import { GitHubGlyph, ProviderTile } from "./ProviderLogo";
import { ResetTimeline } from "./ResetTimeline";
import { ThemeToggle } from "./ThemeToggle";

const btn = "btn";
const btnPrimary = "btn btn-primary";

/**
 * The dashboard: a view of the usage engine (lib/usage/engine.ts), which
 * keeps polling while other pages show. Its dialogs, toasts and shortcuts
 * belong to the app shell. In the desktop app's window on Windows the title
 * bar takes the logo, the Team link and settings, and the header here is a
 * toolbar.
 */
export function Dashboard() {
  const snap = useUsage((s) => s);
  const desktop = useDesktop();
  const mod = useModKey();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const { user, accounts, states, history } = snap;
  const hydrated = snap.phase === "ready";

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const usages = useMemo<Record<string, Usage | undefined>>(() => Object.fromEntries(accounts.map((a) => [a.id, states[a.id]?.usage])), [accounts, states]);
  const ranked = useMemo(() => rankAccounts(accounts, usages), [accounts, usages]);
  const resets = upcomingResets(accounts, usages, now);
  const anyLoading = accounts.some((a) => states[a.id]?.status === "loading");
  const freshest = accounts
    .map((a) => states[a.id]?.usage?.fetchedAt)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .sort((a, b) => b - a)[0];

  const waitingOn = resets.find((e) => e.window.usedPercent >= 85);
  const title = accounts.length === 0 ? SITE.name : waitingOn ? `${formatCountdown(waitingOn.at - now)} · ${SITE.name}` : `ready · ${SITE.name}`;
  // Every render (each second), as navigating back here lets Next set the page's own title after this ran.
  useEffect(() => {
    if (document.title !== title) document.title = title;
  });

  async function copyStatus() {
    if (!(await engine.copyStatus())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const openSettings = () => openShell({ settings: desktop ? "general" : "appearance" });

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 titlebar:py-4">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex items-center gap-3 titlebar:hidden">
            <Mark size={44} animated />
            <div>
              <h1 className="text-2xl leading-none">
                <Wordmark />
              </h1>
              <p className="eyebrow mt-1.5">{SITE.tagline}</p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {user ? (
              <span className="mr-1 flex items-center gap-2 font-mono text-[11px] text-muted">
                <button type="button" onClick={() => openShell("account")} className="max-w-[16rem] truncate hover:text-fg" title="Account settings: password, devices, delete">
                  {user.email}
                </button>
                <button type="button" onClick={() => void engine.signOut()} className="flex items-center gap-1 text-faint hover:text-fg" title="Sign out">
                  <Icon name="logout" size={12} />
                  sign out
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => openShell("auth")} className={btn}>
                <Icon name="user" />
                Sign in
              </button>
            )}
            <Link href="/team" title="Your team: people, computers, projects, token usage and remote sessions" className={`${btn} titlebar:hidden`}>
              <Icon name="users" />
              Team
            </Link>
            <a href={SITE.repo} target="_blank" rel="noopener noreferrer" title="Open source · star the repo on GitHub" className={`${btn} desktop:hidden`}>
              <Icon name="star" fill className="text-amber-400" />
              Star us on GitHub
            </a>
            <ThemeToggle className={`${btn} titlebar:hidden`} />
            <button
              type="button"
              onClick={() => void engine.toggleNotify()}
              disabled={accounts.length === 0}
              aria-pressed={snap.notify}
              title="Notification when a limit resets, nears its end or runs out"
              className={`${btn} ${snap.notify ? "btn-accent" : ""}`}
            >
              <Icon name={snap.notify ? "bell" : "bellOff"} />
              {snap.notify ? "Notifying" : "Notify me"}
            </button>
            <button type="button" onClick={() => void copyStatus()} disabled={accounts.length === 0} title="Copy a text summary of every account" className={btn}>
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Copy status"}
            </button>
            <button
              type="button"
              onClick={() => engine.refresh()}
              disabled={anyLoading || accounts.length === 0}
              title={desktop ? "Refresh every account (Ctrl+R)" : "Refresh every account"}
              className={btn}
            >
              <Icon name="refresh" className={anyLoading ? "spin" : undefined} />
              Refresh
            </button>
            <button type="button" onClick={() => openShell("add")} title={desktop ? "Add account (Ctrl+N)" : undefined} className={btnPrimary}>
              <Icon name="plus" />
              Add account
            </button>
            <button type="button" onClick={openSettings} className={`${btn} px-2 titlebar:hidden`} aria-label="Settings" title="Settings (Ctrl+,)">
              <Icon name="settings" />
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span>
            {snap.mode === "remote" ? "accounts synced to your AI Cooldown account · tokens stay on the server" : `guest mode · accounts and tokens stay in this ${desktop ? "app" : "browser"}`}
          </span>
          <span className="flex items-center gap-2 tabular-nums" suppressHydrationWarning>
            {accounts.length > 0 && <span className={`h-1.5 w-1.5 rounded-full ${anyLoading ? "live bg-accent" : "bg-emerald-500"}`} aria-hidden />}
            {freshest ? `latest data ${formatAgo(now - freshest)}` : "no data yet"} · {new Date(now).toLocaleTimeString()}
          </span>
        </div>
      </header>

      {snap.importOffer && (
        <div className="fade-in mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-panel px-4 py-3">
          <p className="text-sm text-fg-2">
            This {desktop ? "app" : "browser"} has {snap.importOffer.length} guest account{snap.importOffer.length === 1 ? "" : "s"}. Move{" "}
            {snap.importOffer.length === 1 ? "it" : "them"} to your {SITE.name} account so you see {snap.importOffer.length === 1 ? "it" : "them"} everywhere?
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => engine.dismissImport()} className={btn}>
              Keep here
            </button>
            <button type="button" onClick={() => void engine.importGuest()} className={btnPrimary}>
              Move to account
            </button>
          </div>
        </div>
      )}

      {hydrated && <MySessions user={user} now={now} />}

      {hydrated && accounts.length === 0 ? (
        <section className="fade-in mt-10 rounded-2xl border border-dashed border-line p-10 text-center">
          <div className="mx-auto mb-4 flex items-center justify-center gap-3">
            <ProviderTile provider="claude" size={44} />
            <ProviderTile provider="codex" size={44} />
          </div>
          <p className="eyebrow">no accounts</p>
          <h2 className="mt-2 text-lg font-medium text-fg">Connect a Claude or ChatGPT/Codex account</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            You get every session, weekly and per-model limit (Fable included), when each resets, which account to use next, and whether your current pace runs
            out before the reset. {user ? "Accounts are stored on the server and follow you across devices." : `Without signing in, everything stays in this ${desktop ? "app" : "browser"}.`}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <button type="button" onClick={() => openShell("add")} className={btnPrimary}>
              <Icon name="plus" />
              Add your first account
            </button>
            {!user && (
              <button type="button" onClick={() => openShell("auth")} className={btn}>
                <Icon name="user" />
                Sign in to sync
              </button>
            )}
          </div>
          <p className="mt-5 text-xs text-faint">
            Tip: press <kbd className="rounded border border-line px-1 font-mono text-[10px]">{mod}+K</kbd> to search and run any command.
          </p>
        </section>
      ) : (
        <>
          {accounts.length > 0 && (
            <div className="mt-6 space-y-6">
              <div className="space-y-4">
                <h2 className="mb-2 text-sm font-medium text-muted">Right now</h2>
                <Overview accounts={accounts} usages={usages} resets={resets} now={now} />
                <CommandPanel ranked={ranked} now={now} />
              </div>
              <div>
                <h2 className="mb-2 text-sm font-medium text-muted">Capacity comes back</h2>
                <ResetTimeline accounts={accounts} events={resets} now={now} />
              </div>
              <h2 id="accounts-heading" className="text-sm font-medium text-muted">
                Accounts
              </h2>
            </div>
          )}
          <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                state={states[account.id]}
                history={history[account.id]}
                now={now}
                synced={snap.mode === "remote"}
                onRefresh={() => engine.refresh(account.id)}
                onRemove={() => engine.remove(account.id)}
                onRename={(label) => void engine.rename(account.id, label)}
                onCopy={() => void engine.copyStatus(account.id)}
              />
            ))}
          </div>
        </>
      )}

      {hydrated && <LocalPanel now={now} user={user} />}

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-4 font-mono text-[11px] text-faint desktop:hidden">
        <span>
          Open source under MIT ·{" "}
          <a href={SITE.repo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-fg">
            <GitHubGlyph size={11} />
            {SITE.repo.replace("https://", "")}
          </a>{" "}
          · self-host it or get the{" "}
          <a href={`${SITE.repo}#desktop-app`} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg">
            desktop app
          </a>
        </span>
        <span>
          Not affiliated with Anthropic or OpenAI ·{" "}
          <Link href="/guides" className="text-muted hover:text-fg">
            guides
          </Link>{" "}
          ·{" "}
          <Link href="/brand" className="text-muted hover:text-fg">
            brand
          </Link>
        </span>
      </footer>
    </main>
  );
}
