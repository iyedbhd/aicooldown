"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api";
import { formatAgo, formatCountdown, formatDateTime, formatPlan } from "@/lib/format";
import { dropHistory, loadHistory, recordSamples, type History } from "@/lib/history";
import { notifyChanges, notifyEnabled, requestNotifyPermission, setNotifyEnabled } from "@/lib/notify";
import { POLL_INTERVAL_MS, backoffMs } from "@/lib/poll";
import { codexIdentityFromTokens } from "@/lib/providers/codex";
import { fetchSession, signOut, type SessionUser } from "@/lib/session";
import { SITE } from "@/lib/site";
import { rankAccounts, upcomingResets } from "@/lib/stats";
import { loadAccounts, saveAccounts } from "@/lib/storage";
import { localStore, remoteStore, type AccountStore, type NewAccount } from "@/lib/store";
import type { Account, Identity, Usage } from "@/lib/types";
import { loadUsage, type UsageState } from "@/lib/usage-client";
import { AccountCard } from "./AccountCard";
import { AccountDialog } from "./AccountDialog";
import { AddAccountDialog } from "./AddAccountDialog";
import { AuthDialog } from "./AuthDialog";
import { CommandPanel } from "./CommandPanel";
import { Icon } from "./Icon";
import { Mark, Wordmark } from "./Logo";
import { Overview } from "./Overview";
import { GitHubGlyph, ProviderTile } from "./ProviderLogo";
import { ResetTimeline } from "./ResetTimeline";
import { ThemeToggle } from "./ThemeToggle";

const SCHEDULER_MS = 5_000;
const FOCUS_MIN_GAP_MS = 60_000;

const btn = "btn";
const btnPrimary = "btn btn-primary";

export function Dashboard() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [store, setStore] = useState<AccountStore>(localStore);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [states, setStates] = useState<Record<string, UsageState>>({});
  const [history, setHistory] = useState<History>({});
  const [now, setNow] = useState(() => Date.now());
  const [showAdd, setShowAdd] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [notify, setNotify] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [importOffer, setImportOffer] = useState<Account[] | null>(null);
  const accountsRef = useRef<Account[]>([]);
  const storeRef = useRef<AccountStore>(localStore);
  const statesRef = useRef<Record<string, UsageState>>({});
  const historyRef = useRef<History>({});
  const notifyRef = useRef(false);
  const lastFocusRefresh = useRef(0);

  const setAccountList = useCallback((next: Account[]) => {
    accountsRef.current = next;
    setAccounts(next);
  }, []);

  const patchState = useCallback((id: string, patch: Partial<UsageState>) => {
    statesRef.current = { ...statesRef.current, [id]: { ...statesRef.current[id], ...patch } as UsageState };
    setStates(statesRef.current);
  }, []);

  const flash = useCallback((text: string, ms = 6000) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? null : n)), ms);
  }, []);

  /** Guest mode only: one-time subscription lookup for accounts added before plans were stored. */
  const ensurePlan = useCallback(
    async (account: Account) => {
      if (account.plan !== undefined || storeRef.current.mode !== "local" || !account.accessToken) return;
      let plan: string | null = null;
      if (account.provider === "codex") plan = codexIdentityFromTokens(account.accessToken).plan ?? null;
      else {
        const res = await postJson<Identity>("/api/identity", { provider: "claude", accessToken: account.accessToken });
        if (!res.ok && res.status !== 401) return;
        plan = res.ok ? (res.data.plan ?? null) : null;
      }
      await storeRef.current.patch(account.id, { plan });
      setAccountList(accountsRef.current.map((a) => (a.id === account.id ? { ...a, plan } : a)));
    },
    [setAccountList],
  );

  const refreshOne = useCallback(
    async (account: Account) => {
      if (statesRef.current[account.id]?.status === "loading") return;
      patchState(account.id, { status: "loading" });
      const result = await loadUsage(account, storeRef.current.mode);
      if (!accountsRef.current.some((a) => a.id === account.id)) return; // removed meanwhile
      if (result.tokens) {
        const patch = { accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken ?? account.refreshToken, expiresAt: result.tokens.expiresAt };
        await storeRef.current.patch(account.id, patch);
        setAccountList(accountsRef.current.map((a) => (a.id === account.id ? { ...a, ...patch } : a)));
      }
      if (result.usage?.plan && account.plan !== result.usage.plan && storeRef.current.mode === "remote") {
        setAccountList(accountsRef.current.map((a) => (a.id === account.id ? { ...a, plan: result.usage!.plan } : a)));
      }
      if (result.usage && !result.usage.stale) {
        historyRef.current = recordSamples(historyRef.current, account.id, result.usage);
        setHistory(historyRef.current);
      }
      const prev = statesRef.current[account.id] ?? { status: "loading" };
      const at = Date.now();
      if (notifyRef.current && result.usage && !result.usage.stale) notifyChanges(account, prev.usage, result.usage, at);
      const patch: UsageState = {
        status: result.error ? "error" : "ok",
        usage: result.usage ?? prev.usage,
        error: result.error,
      };
      if (result.rateLimited) {
        const hits = (prev.rateLimitHits ?? 0) + 1;
        patch.rateLimitHits = hits;
        patch.rateLimitedUntil = at + backoffMs(hits);
        patch.nextPollAt = patch.rateLimitedUntil;
      } else {
        patch.rateLimitHits = 0;
        patch.rateLimitedUntil = undefined;
        patch.nextPollAt = at + POLL_INTERVAL_MS[account.provider];
      }
      patchState(account.id, patch);
      if (result.usage) void ensurePlan(account);
    },
    [patchState, setAccountList, ensurePlan],
  );

  /** Polls every account whose turn has come. */
  const pollDue = useCallback(
    (force = false) => {
      const at = Date.now();
      for (const account of accountsRef.current) {
        const s = statesRef.current[account.id];
        if (s?.status === "loading") continue;
        if (force || s?.nextPollAt === undefined || at >= s.nextPollAt) void refreshOne(account);
      }
    },
    [refreshOne],
  );

  /** Switches the source of accounts and reloads the list; usage state starts fresh. */
  const switchStore = useCallback(
    async (next: AccountStore) => {
      storeRef.current = next;
      setStore(next);
      statesRef.current = {};
      setStates({});
      try {
        setAccountList(await next.list());
      } catch (err) {
        flash(err instanceof Error ? err.message : "Could not load accounts.");
        setAccountList([]);
      }
      pollDue(true);
    },
    [setAccountList, pollDue, flash],
  );

  useEffect(() => {
    historyRef.current = loadHistory();
    notifyRef.current = notifyEnabled();
    setHistory(historyRef.current);
    setNotify(notifyRef.current);
    void (async () => {
      const u = await fetchSession();
      setUser(u);
      await switchStore(u ? remoteStore : localStore);
      setHydrated(true);
    })();
    // switchStore is stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const scheduler = setInterval(() => pollDue(), SCHEDULER_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onFocus = () => {
      if (Date.now() - lastFocusRefresh.current < FOCUS_MIN_GAP_MS) return;
      lastFocusRefresh.current = Date.now();
      pollDue();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(scheduler);
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [hydrated, pollDue]);

  async function handleSignedIn(u: SessionUser) {
    setShowAuth(false);
    setUser(u);
    const local = loadAccounts().filter((a) => a.accessToken);
    await switchStore(remoteStore);
    if (local.length) setImportOffer(local);
  }

  async function importLocal(list: Account[]) {
    setImportOffer(null);
    try {
      const created = await remoteStore.addMany(list.map((a) => ({ ...a, accessToken: a.accessToken! })));
      saveAccounts([]);
      setAccountList([...accountsRef.current, ...created]);
      for (const a of created) void refreshOne(a);
      flash(`Moved ${created.length} account${created.length === 1 ? "" : "s"} to your ${SITE.name} account and cleared them from this browser.`);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Import failed.");
    }
  }

  async function handleSignOut() {
    await signOut();
    setUser(null);
    await switchStore(localStore);
  }

  async function handleAccountDeleted() {
    setShowAccount(false);
    setUser(null);
    await switchStore(localStore);
    setNote("Your account and everything stored on the server are gone.");
  }

  async function addAccount(partial: NewAccount) {
    const account = await storeRef.current.add(partial);
    setAccountList([...accountsRef.current, account]);
    setShowAdd(false);
    void refreshOne(account);
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`Remove “${account.label}”?`)) return;
    await storeRef.current.remove(account.id);
    setAccountList(accountsRef.current.filter((a) => a.id !== account.id));
    historyRef.current = dropHistory(historyRef.current, account.id);
    setHistory(historyRef.current);
    const next = { ...statesRef.current };
    delete next[account.id];
    statesRef.current = next;
    setStates(next);
  }

  async function renameAccount(account: Account, label: string) {
    await storeRef.current.rename(account.id, label);
    setAccountList(accountsRef.current.map((a) => (a.id === account.id ? { ...a, label } : a)));
  }

  async function toggleNotify() {
    if (notify) {
      notifyRef.current = false;
      setNotifyEnabled(false);
      setNotify(false);
      return;
    }
    const result = await requestNotifyPermission();
    if (result !== "granted") {
      flash(result === "denied" ? "Notifications are blocked for this site in your browser." : "This browser does not support notifications.");
      return;
    }
    notifyRef.current = true;
    setNotifyEnabled(true);
    setNotify(true);
    flash("Notifications on: resets, 90% crossings and exhaustion, while this tab is open.");
  }

  async function copyStatus() {
    const lines = [`${SITE.name} · ${new Date().toLocaleString()}`];
    for (const account of accountsRef.current) {
      const usage = statesRef.current[account.id]?.usage;
      const plan = formatPlan(account.plan ?? usage?.plan);
      const head = `${account.provider === "claude" ? "Claude" : "Codex"} · ${account.label}${plan ? ` (${plan})` : ""}`;
      if (!usage) {
        lines.push(`${head}: no data`);
        continue;
      }
      const t = Date.now();
      const parts = usage.windows.map((w) => {
        const reset = w.resetsAt ? `, resets ${formatDateTime(w.resetsAt, t)} (in ${formatCountdown(new Date(w.resetsAt).getTime() - t)})` : "";
        return `${w.label} ${Math.round(100 - w.usedPercent)}% left${reset}`;
      });
      lines.push(`${head}: ${parts.join("; ")}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy your status:", lines.join("\n"));
    }
  }

  const usages: Record<string, Usage | undefined> = Object.fromEntries(accounts.map((a) => [a.id, states[a.id]?.usage]));
  const ranked = rankAccounts(accounts, usages);
  const resets = upcomingResets(accounts, usages, now);
  const anyLoading = accounts.some((a) => states[a.id]?.status === "loading");
  const freshest = accounts
    .map((a) => states[a.id]?.usage?.fetchedAt)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .sort((a, b) => b - a)[0];

  const waitingOn = resets.find((e) => e.window.usedPercent >= 85);
  const title = accounts.length === 0 ? SITE.name : waitingOn ? `${formatCountdown(waitingOn.at - now)} · ${SITE.name}` : `ready · ${SITE.name}`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <Mark size={44} animated />
            <div>
              <h1 className="text-2xl leading-none">
                <Wordmark />
              </h1>
              <p className="eyebrow mt-1.5">{SITE.tagline}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {user ? (
              <span className="mr-1 flex items-center gap-2 font-mono text-[11px] text-muted">
                <button type="button" onClick={() => setShowAccount(true)} className="max-w-[16rem] truncate hover:text-fg" title="Account settings: password, devices, delete">
                  {user.email}
                </button>
                <button type="button" onClick={() => void handleSignOut()} className="flex items-center gap-1 text-faint hover:text-fg" title="Sign out">
                  <Icon name="logout" size={12} />
                  sign out
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setShowAuth(true)} className={btn}>
                <Icon name="user" />
                Sign in
              </button>
            )}
            <a href={SITE.repo} target="_blank" rel="noopener noreferrer" title="Open source · star the repo on GitHub" className={btn}>
              <Icon name="star" fill className="text-amber-400" />
              Star us on GitHub
            </a>
            <ThemeToggle className={btn} />
            <button type="button" onClick={() => void toggleNotify()} disabled={accounts.length === 0} aria-pressed={notify} title="Browser notification when a limit resets, crosses 90% or runs out" className={`${btn} ${notify ? "btn-accent" : ""}`}>
              <Icon name={notify ? "bell" : "bellOff"} />
              {notify ? "Notifying" : "Notify me"}
            </button>
            <button type="button" onClick={() => void copyStatus()} disabled={accounts.length === 0} title="Copy a text summary of every account" className={btn}>
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Copy status"}
            </button>
            <button type="button" onClick={() => pollDue(true)} disabled={anyLoading || accounts.length === 0} className={btn}>
              <Icon name="refresh" className={anyLoading ? "spin" : undefined} />
              Refresh
            </button>
            <button type="button" onClick={() => setShowAdd(true)} className={btnPrimary}>
              <Icon name="plus" />
              Add account
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span>
            {store.mode === "remote" ? "accounts synced to your AI Cooldown account · tokens stay on the server" : "guest mode · accounts and tokens stay in this browser"}
          </span>
          <span className="flex items-center gap-2 tabular-nums" suppressHydrationWarning>
            {accounts.length > 0 && <span className={`h-1.5 w-1.5 rounded-full ${anyLoading ? "live bg-accent" : "bg-emerald-500"}`} aria-hidden />}
            {freshest ? `latest data ${formatAgo(now - freshest)}` : "no data yet"} · {new Date(now).toLocaleTimeString()}
          </span>
        </div>
      </header>

      {note && (
        <div role="status" className="toast fixed bottom-4 right-4 z-40 max-w-sm rounded-xl border border-line bg-panel px-4 py-3 text-sm text-fg-2 shadow-lg">
          {note}
        </div>
      )}

      {importOffer && (
        <div className="fade-in mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-panel px-4 py-3">
          <p className="text-sm text-fg-2">
            This browser has {importOffer.length} guest account{importOffer.length === 1 ? "" : "s"}. Move {importOffer.length === 1 ? "it" : "them"} to your{" "}
            {SITE.name} account so you see {importOffer.length === 1 ? "it" : "them"} everywhere?
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setImportOffer(null)} className={btn}>
              Keep here
            </button>
            <button type="button" onClick={() => void importLocal(importOffer)} className={btnPrimary}>
              Move to account
            </button>
          </div>
        </div>
      )}

      {hydrated && accounts.length === 0 ? (
        <section className="fade-in mt-10 rounded-2xl border border-dashed border-line p-10 text-center">
          <div className="mx-auto mb-4 flex items-center justify-center gap-3">
            <ProviderTile provider="claude" size={44} />
            <ProviderTile provider="codex" size={44} />
          </div>
          <p className="eyebrow">no accounts</p>
          <h2 className="mt-2 text-lg font-medium text-fg">Connect a Claude or ChatGPT/Codex account</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            You get every session, weekly and per-model limit (Fable included), when each resets, which account to use next, and
            whether your current pace runs out before the reset.{" "}
            {user ? "Accounts are stored on the server and follow you across devices." : "Without signing in, everything stays in this browser."}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <button type="button" onClick={() => setShowAdd(true)} className={btnPrimary}>
              <Icon name="plus" />
              Add your first account
            </button>
            {!user && (
              <button type="button" onClick={() => setShowAuth(true)} className={btn}>
                <Icon name="user" />
                Sign in to sync
              </button>
            )}
          </div>
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
                <ResetTimeline events={resets} now={now} />
              </div>
              <h2 className="text-sm font-medium text-muted">Accounts</h2>
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
                synced={store.mode === "remote"}
                onRefresh={() => void refreshOne(account)}
                onRemove={() => void removeAccount(account)}
                onRename={(label) => void renameAccount(account, label)}
              />
            ))}
          </div>
        </>
      )}

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-4 font-mono text-[11px] text-faint">
        <span>
          Open source under MIT ·{" "}
          <a href={SITE.repo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-fg">
            <GitHubGlyph size={11} />
            {SITE.repo.replace("https://", "")}
          </a>{" "}
          · self-host it or run it locally
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

      {showAdd && <AddAccountDialog onAdd={addAccount} onClose={() => setShowAdd(false)} />}
      {showAuth && <AuthDialog onSignedIn={(u) => void handleSignedIn(u)} onClose={() => setShowAuth(false)} localCount={accounts.length} />}
      {showAccount && user && (
        <AccountDialog
          user={user}
          linkedCount={accounts.length}
          onClose={() => setShowAccount(false)}
          onNote={(text) => {
            setNote(text);
            setShowAccount(false);
          }}
          onDeleted={() => void handleAccountDeleted()}
        />
      )}
    </main>
  );
}
