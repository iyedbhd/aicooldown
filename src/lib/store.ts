import { postJson } from "./api";
import { loadAccounts, saveAccounts } from "./storage";
import type { Account } from "./types";

export type NewAccount = Omit<Account, "id" | "addedAt"> & { accessToken: string };

/**
 * Where linked accounts live. Guests keep them in this browser; signed-in
 * users keep them on the server, where the tokens stay.
 */
export interface AccountStore {
  readonly mode: "local" | "remote";
  list(): Promise<Account[]>;
  add(account: NewAccount): Promise<Account>;
  addMany(accounts: NewAccount[]): Promise<Account[]>;
  rename(id: string, label: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Guest only: persist refreshed tokens or a looked-up plan. Remote store persists these server-side. */
  patch(id: string, fields: Partial<Pick<Account, "plan" | "expiresAt" | "accountId" | "accessToken" | "refreshToken">>): Promise<void>;
}

async function failing<T>(res: { ok: true; data: T } | { ok: false; error: string }): Promise<T> {
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export const localStore: AccountStore = {
  mode: "local",
  async list() {
    return loadAccounts();
  },
  async add(a) {
    const account: Account = { ...a, id: crypto.randomUUID(), addedAt: Date.now() };
    saveAccounts([...loadAccounts(), account]);
    return account;
  },
  async addMany(list) {
    const created = list.map((a) => ({ ...a, id: crypto.randomUUID(), addedAt: Date.now() }));
    saveAccounts([...loadAccounts(), ...created]);
    return created;
  },
  async rename(id, label) {
    saveAccounts(loadAccounts().map((a) => (a.id === id ? { ...a, label } : a)));
  },
  async remove(id) {
    saveAccounts(loadAccounts().filter((a) => a.id !== id));
  },
  async patch(id, fields) {
    saveAccounts(loadAccounts().map((a) => (a.id === id ? { ...a, ...fields } : a)));
  },
};

export const remoteStore: AccountStore = {
  mode: "remote",
  async list() {
    const res = await fetch("/api/accounts", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 401 ? "Signed out" : `HTTP ${res.status}`);
    return ((await res.json()) as { accounts: Account[] }).accounts;
  },
  async add(a) {
    const { accounts } = await failing(await postJson<{ accounts: Account[] }>("/api/accounts", { account: a }));
    return accounts[0];
  },
  async addMany(list) {
    const { accounts } = await failing(await postJson<{ accounts: Account[] }>("/api/accounts", { accounts: list }));
    return accounts;
  },
  async rename(id, label) {
    const res = await fetch("/api/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, label }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  async remove(id) {
    // keepalive: a removal committed as the page goes away still reaches the server.
    const res = await fetch("/api/accounts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), keepalive: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  async patch() {
    /* the server already persisted it */
  },
};
