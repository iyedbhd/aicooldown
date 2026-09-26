import { useSyncExternalStore } from "react";
import { postJson } from "@/lib/api";
import { desktopApp } from "@/lib/desktop";
import { formatCountdown, formatDateTime, formatPlan } from "@/lib/format";
import { dropHistory, loadHistory, recordSamples, type History } from "@/lib/history";
import { localAction } from "@/lib/local";
import { notifyChanges, notifyEnabled, requestNotifyPermission, setNotifyEnabled } from "@/lib/notify";
import { POLL_INTERVAL_MS, backoffMs } from "@/lib/poll";
import { codexIdentityFromTokens } from "@/lib/providers/codex";
import { checkSession, fetchSession, onSessionChange, signOut, type SessionUser } from "@/lib/session";
import { SITE } from "@/lib/site";
import { loadAccounts, saveAccounts } from "@/lib/storage";
import { localStore, remoteStore, type AccountStore, type NewAccount } from "@/lib/store";
import type { Account, Identity } from "@/lib/types";
import { copyText, toast } from "@/lib/ui";
import { loadUsage, type UsageState } from "@/lib/usage-client";

/*
 * The usage engine: linked accounts, their usage, polling, history and limit
 * notifications. It lives outside React, once per page load, so it keeps
 * polling whichever page is showing (in the desktop app, where it runs on
 * every page, closing the window to the tray on the Team page no longer stops
 * the notifications). Views read it through useUsage(); AppShell starts it.
 */

const SCHEDULER_MS = 5_000;
const FOCUS_MIN_GAP_MS = 60_000;
/** The desktop app reads the account list again on focus at most this often, so accounts added elsewhere show up. */
const RELIST_MIN_GAP_MS = 5 * 60_000;
/** How long a removed account can be brought back. */
const UNDO_MS = 6_000;

export type Snapshot = {
  /** idle until first needed (on the website: until the dashboard shows), then booting, then ready. */
  phase: "idle" | "booting" | "ready";
  user: SessionUser | null;
  mode: "local" | "remote";
  /** Linked accounts, without the ones removed a moment ago and still undoable. */
  accounts: Account[];
  states: Record<string, UsageState>;
  history: History;
  notify: boolean;
  /** Guest accounts on this device, offered to move into the account just signed in to. */
  importOffer: Account[] | null;
};

const INITIAL: Snapshot = { phase: "idle", user: null, mode: "local", accounts: [], states: {}, history: {}, notify: false, importOffer: null };

type PendingRemoval = { account: Account; index: number; store: AccountStore; generation: number };

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const where = () => (desktopApp() ? "app" : "browser");

class UsageEngine {
  private snap: Snapshot = INITIAL;
  private listeners = new Set<() => void>();
  private store: AccountStore = localStore;
  /** Bumped by every store switch: answers that started before it are dropped. */
  private generation = 0;
  private active = false;
  private booting: Promise<void> | null = null;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private lastFocusPoll = 0;
  private lastList = 0;
  private pending = new Map<string, PendingRemoval>();
  private syncing: Promise<void> | null = null;
  private attached = 0;
  private detach: (() => void) | null = null;

  getSnapshot = (): Snapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  private find(id: string): Account | undefined {
    return this.snap.accounts.find((a) => a.id === id);
  }

  private patchAccount(id: string, patch: Partial<Account>) {
    this.set({ accounts: this.snap.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  }

  private patchState(id: string, patch: Partial<UsageState>) {
    this.set({ states: { ...this.snap.states, [id]: { ...this.snap.states[id], ...patch } as UsageState } });
  }

  // ---- Lifecycle.

  /** Window listeners: focus, leaving the page, signing in or out anywhere. Counted, so repeated effects are harmless. */
  attach(): () => void {
    if (this.attached++ === 0) {
      const onFocus = () => this.onFocus();
      const onHide = () => this.flushRemovals();
      window.addEventListener("focus", onFocus);
      window.addEventListener("pagehide", onHide);
      const offSession = onSessionChange(() => void this.resync());
      this.detach = () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("pagehide", onHide);
        offSession();
      };
    }
    return () => {
      if (--this.attached > 0) return;
      this.detach?.();
      this.detach = null;
    };
  }

  /** Polling on or off: on on the dashboard, and on every page in the desktop app. Starts up the first time. */
  setActive(on: boolean): void {
    const was = this.active;
    this.active = on;
    if (!on) return this.stopScheduler();
    if (!this.booting) {
      this.booting = this.boot();
      return;
    }
    if (this.snap.phase !== "ready") return; // boot() starts polling when it is done
    this.startScheduler();
    // Back on the dashboard: the account may have signed in or out, or changed its list, elsewhere.
    if (!was) void this.resync();
  }

  private async boot() {
    this.set({ phase: "booting", history: loadHistory(), notify: notifyEnabled() });
    await this.switchStore(await fetchSession());
    this.set({ phase: "ready" });
    if (this.active) this.startScheduler();
  }

  private startScheduler() {
    this.scheduler ??= setInterval(() => this.pollDue(), SCHEDULER_MS);
  }

  private stopScheduler() {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
  }

  private onFocus() {
    if (!this.active || this.snap.phase !== "ready") return;
    const now = Date.now();
    if (desktopApp() && now - this.lastList >= RELIST_MIN_GAP_MS) {
      void this.resync();
      return;
    }
    if (now - this.lastFocusPoll < FOCUS_MIN_GAP_MS) return;
    this.lastFocusPoll = now;
    this.pollDue();
  }

  /** Signed in, out or deleted, possibly on another page; or back after a while. Follows the session and reads the list again. */
  private resync(): Promise<void> {
    if (this.snap.phase !== "ready") return Promise.resolve(); // booting reads the session anyway
    this.syncing ??= (async () => {
      try {
        const user = await checkSession();
        if (user === undefined) return; // offline: keep what is on screen
        if ((user?.id ?? null) !== (this.snap.user?.id ?? null)) {
          // Signing in from guest mode offers to move this device's guest accounts into the account.
          const guests = !this.snap.user && user ? loadAccounts().filter((a) => a.accessToken) : [];
          await this.switchStore(user);
          if (guests.length) this.set({ importOffer: guests });
          return;
        }
        await this.relist();
        if (this.active) this.pollDue();
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /** Switches between guest accounts and the signed-in account's; usage state starts fresh. */
  private async switchStore(user: SessionUser | null) {
    this.flushRemovals();
    const next = user ? remoteStore : localStore;
    this.store = next;
    const generation = ++this.generation;
    this.set({ user, mode: next.mode, states: {}, importOffer: null });
    let accounts: Account[] = [];
    try {
      accounts = await next.list();
    } catch (err) {
      toast(message(err, "Could not load accounts."), { tone: "error" });
    }
    if (generation !== this.generation) return;
    this.lastList = Date.now();
    this.set({ accounts });
    if (this.active) this.pollDue(true);
  }

  /** The same store's list again, keeping what is known about the accounts still in it. */
  private async relist() {
    const generation = this.generation;
    let list: Account[];
    try {
      list = await this.store.list();
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    this.lastList = Date.now();
    const accounts = list.filter((a) => !this.pending.has(a.id));
    const ids = new Set(accounts.map((a) => a.id));
    this.set({ accounts, states: Object.fromEntries(Object.entries(this.snap.states).filter(([id]) => ids.has(id))) });
  }

  // ---- Polling.

  /** Polls every account whose turn has come, or all of them. */
  pollDue(force = false): void {
    const at = Date.now();
    for (const account of this.snap.accounts) {
      const s = this.snap.states[account.id];
      if (s?.status === "loading") continue;
      if (force || s?.nextPollAt === undefined || at >= s.nextPollAt) void this.refreshOne(account.id);
    }
  }

  /** One account now, or every account. */
  refresh(id?: string): void {
    if (id) void this.refreshOne(id);
    else this.pollDue(true);
  }

  private async refreshOne(id: string) {
    const account = this.find(id);
    if (!account || this.snap.states[id]?.status === "loading") return;
    const { store, generation } = this;
    this.patchState(id, { status: "loading" });
    const result = await loadUsage(account, store.mode);
    // Signed in or out meanwhile, or removed.
    if (generation !== this.generation || !this.find(id)) return;
    if (result.tokens) {
      const patch = { accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken ?? this.find(id)?.refreshToken, expiresAt: result.tokens.expiresAt };
      await store.patch(id, patch);
      this.patchAccount(id, patch);
    }
    const plan = result.usage?.plan;
    if (plan && store.mode === "remote" && this.find(id)?.plan !== plan) this.patchAccount(id, { plan });
    if (result.usage && !result.usage.stale) this.set({ history: recordSamples(this.snap.history, id, result.usage) });
    const prev = this.snap.states[id] ?? { status: "loading" };
    const at = Date.now();
    const current = this.find(id);
    if (this.snap.notify && current && result.usage && !result.usage.stale) notifyChanges(current, prev.usage, result.usage, at);
    const next: Partial<UsageState> = { status: result.error ? "error" : "ok", usage: result.usage ?? prev.usage, error: result.error };
    if (result.rateLimited) {
      const hits = (prev.rateLimitHits ?? 0) + 1;
      next.rateLimitHits = hits;
      next.rateLimitedUntil = at + backoffMs(hits);
      next.nextPollAt = next.rateLimitedUntil;
    } else {
      next.rateLimitHits = 0;
      next.rateLimitedUntil = undefined;
      next.nextPollAt = at + POLL_INTERVAL_MS[account.provider];
    }
    this.patchState(id, next);
    if (result.usage) void this.ensurePlan(id);
  }

  /** Guest mode only: a one-time subscription lookup for accounts added before plans were stored. */
  private async ensurePlan(id: string) {
    const account = this.find(id);
    if (!account || account.plan !== undefined || this.store.mode !== "local" || !account.accessToken) return;
    const { store, generation } = this;
    let plan: string | null = null;
    if (account.provider === "codex") plan = codexIdentityFromTokens(account.accessToken).plan ?? null;
    else {
      const res = await postJson<Identity>("/api/identity", { provider: "claude", accessToken: account.accessToken });
      if (!res.ok && res.status !== 401) return;
      plan = res.ok ? (res.data.plan ?? null) : null;
    }
    if (generation !== this.generation || !this.find(id)) return;
    await store.patch(id, { plan });
    this.patchAccount(id, { plan });
  }

  // ---- Accounts.

  /** Throws, so the dialog that asked can show why. */
  async add(partial: NewAccount): Promise<void> {
    const account = await this.store.add(partial);
    this.set({ accounts: [...this.snap.accounts, account] });
    void this.refreshOne(account.id);
  }

  async rename(id: string, label: string): Promise<void> {
    try {
      await this.store.rename(id, label);
      this.patchAccount(id, { label });
    } catch (err) {
      toast(message(err, "Could not rename it."), { tone: "error" });
    }
  }

  /** Hides it at once; it goes for good when the toast does, unless Undo brings it back. */
  remove(id: string): void {
    const account = this.find(id);
    if (!account) return;
    const index = this.snap.accounts.indexOf(account);
    this.pending.set(id, { account, index, store: this.store, generation: this.generation });
    this.set({ accounts: this.snap.accounts.filter((a) => a.id !== id) });
    toast(`Removed ${account.label}.`, {
      duration: UNDO_MS,
      action: { label: "Undo", run: () => this.undoRemove(id) },
      onClose: (why) => {
        if (why !== "action") void this.commitRemoval(id);
      },
    });
  }

  private restore(p: PendingRemoval) {
    if (p.generation !== this.generation || this.find(p.account.id)) return;
    const accounts = [...this.snap.accounts];
    accounts.splice(Math.min(p.index, accounts.length), 0, p.account);
    this.set({ accounts });
  }

  private undoRemove(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.restore(p);
    void this.refreshOne(id);
  }

  private async commitRemoval(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    try {
      await p.store.remove(id);
    } catch (err) {
      this.restore(p);
      toast(`Could not remove ${p.account.label}: ${message(err, "something went wrong")}.`, { tone: "error" });
      return;
    }
    const states = { ...this.snap.states };
    delete states[id];
    this.set({ states, history: dropHistory(this.snap.history, id) });
  }

  /** Removals still undoable happen now: before a store switch, and when the page goes away. */
  private flushRemovals() {
    for (const id of [...this.pending.keys()]) void this.commitRemoval(id);
  }

  async importGuest(): Promise<void> {
    const list = this.snap.importOffer;
    if (!list) return;
    this.set({ importOffer: null });
    try {
      const created = await remoteStore.addMany(list.map((a) => ({ ...a, accessToken: a.accessToken! })));
      saveAccounts([]);
      this.set({ accounts: [...this.snap.accounts, ...created] });
      for (const a of created) void this.refreshOne(a.id);
      toast(`Moved ${created.length} account${created.length === 1 ? "" : "s"} to your ${SITE.name} account and cleared them from this ${where()}.`);
    } catch (err) {
      toast(message(err, "Import failed."), { tone: "error" });
    }
  }

  dismissImport(): void {
    this.set({ importOffer: null });
  }

  // ---- Session.

  async signOut(): Promise<void> {
    // Announced: resync() switches to the guest accounts.
    await signOut();
    // A computer connected to the account stops reporting to it; it reconnects when the same account signs in here again.
    // Only a copy on the user's computer has one: elsewhere this answers 404.
    await localAction({ action: "disconnect", forget: false });
  }

  /** After the account was deleted (announced, so resync() already switches to guest accounts). */
  async accountDeleted(): Promise<void> {
    await localAction({ action: "disconnect", forget: true });
    toast("Your account and everything stored on the server are gone.", { duration: null });
  }

  // ---- Notifications and status.

  async toggleNotify(): Promise<void> {
    if (this.snap.notify) {
      setNotifyEnabled(false);
      this.set({ notify: false });
      return;
    }
    const result = await requestNotifyPermission();
    if (result !== "granted") {
      toast(result === "denied" ? "Notifications are blocked for this site in your browser." : "This browser does not support notifications.", { tone: "error" });
      return;
    }
    setNotifyEnabled(true);
    this.set({ notify: true });
    toast(`Notifications on${desktopApp() ? ", even while AI Cooldown sits in the tray" : " while this tab is open"}. Settings has what you hear about.`);
  }

  /** A text summary of every account, or of the ones given, for pasting into a chat. */
  statusText(ids?: string[]): string {
    const t = Date.now();
    const lines = [`${SITE.name} · ${new Date(t).toLocaleString()}`];
    for (const account of this.snap.accounts) {
      if (ids && !ids.includes(account.id)) continue;
      const usage = this.snap.states[account.id]?.usage;
      const plan = formatPlan(account.plan ?? usage?.plan);
      const head = `${account.provider === "claude" ? "Claude" : "Codex"} · ${account.label}${plan ? ` (${plan})` : ""}`;
      if (!usage) {
        lines.push(`${head}: no data`);
        continue;
      }
      const parts = usage.windows.map((w) => {
        const reset = w.resetsAt ? `, resets ${formatDateTime(w.resetsAt, t)} (in ${formatCountdown(new Date(w.resetsAt).getTime() - t)})` : "";
        return `${w.label} ${Math.round(100 - w.usedPercent)}% left${reset}`;
      });
      lines.push(`${head}: ${parts.join("; ")}`);
    }
    return lines.join("\n");
  }

  copyStatus(id?: string): Promise<boolean> {
    return copyText(this.statusText(id ? [id] : undefined), "Your status");
  }
}

// One engine per page load, kept across hot reloads in development so two never poll at once.
const holder = globalThis as typeof globalThis & { __aicooldownEngine?: UsageEngine };
export const engine: UsageEngine = (holder.__aicooldownEngine ??= new UsageEngine());

/** Reads part of the engine's state; `select` must return stored values (not new objects or filtered arrays). */
export function useUsage<T>(select: (s: Snapshot) => T): T {
  return useSyncExternalStore(
    engine.subscribe,
    () => select(engine.getSnapshot()),
    () => select(INITIAL),
  );
}
