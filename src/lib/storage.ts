import type { Account } from "./types";

const KEY = "ai-usage-tracker:accounts";

export function loadAccounts(): Account[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Account[]) : [];
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: Account[]): void {
  localStorage.setItem(KEY, JSON.stringify(accounts));
}
