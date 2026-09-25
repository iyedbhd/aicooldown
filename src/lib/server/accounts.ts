import type { MemberAccount } from "../team";
import type { Account, Provider, TokenSet, Usage } from "../types";
import { decrypt, encrypt, newId, openJson, sealJson } from "./crypto";
import { db, ensureSchema, placeholders } from "./db";

/** What the browser sees for a stored account: everything except the tokens. */
export type PublicAccount = Omit<Account, "accessToken" | "refreshToken">;

/** What the server works with internally. */
export type StoredAccount = Account & { accessToken: string };

type Row = Record<string, unknown>;

function toPublic(r: Row): PublicAccount {
  return {
    id: String(r.id),
    provider: String(r.provider) as Provider,
    label: String(r.label),
    plan: r.plan === null || r.plan === undefined ? undefined : String(r.plan),
    expiresAt: r.expires_at === null ? undefined : Number(r.expires_at),
    accountId: r.account_id === null ? undefined : String(r.account_id),
    owned: Number(r.owned) === 1,
    addedAt: Number(r.added_at),
  };
}

function toStored(r: Row): StoredAccount {
  return {
    ...toPublic(r),
    accessToken: decrypt(String(r.access_token)),
    refreshToken: r.refresh_token === null ? undefined : decrypt(String(r.refresh_token)),
  };
}

export async function listAccounts(userId: string): Promise<PublicAccount[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: "SELECT * FROM linked_accounts WHERE user_id = ? ORDER BY position, added_at",
    args: [userId],
  });
  return res.rows.map((r) => toPublic(r as Row));
}

export async function getAccount(userId: string, id: string): Promise<StoredAccount | null> {
  await ensureSchema();
  const res = await db().execute({ sql: "SELECT * FROM linked_accounts WHERE user_id = ? AND id = ?", args: [userId, id] });
  return res.rows[0] ? toStored(res.rows[0] as Row) : null;
}

export type NewStoredAccount = Omit<Account, "id" | "addedAt"> & { accessToken: string };

export async function createAccount(userId: string, a: NewStoredAccount): Promise<PublicAccount> {
  await ensureSchema();
  const id = newId();
  const addedAt = Date.now();
  const pos = await db().execute({ sql: "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM linked_accounts WHERE user_id = ?", args: [userId] });
  await db().execute({
    sql: `INSERT INTO linked_accounts
      (id, user_id, provider, label, plan, access_token, refresh_token, expires_at, account_id, owned, added_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      userId,
      a.provider,
      a.label,
      a.plan ?? null,
      encrypt(a.accessToken),
      a.refreshToken ? encrypt(a.refreshToken) : null,
      a.expiresAt ?? null,
      a.accountId ?? null,
      a.owned ? 1 : 0,
      addedAt,
      Number(pos.rows[0]?.p ?? 0),
    ],
  });
  return { id, provider: a.provider, label: a.label, plan: a.plan, expiresAt: a.expiresAt, accountId: a.accountId, owned: a.owned, addedAt };
}

export async function updateLabel(userId: string, id: string, label: string): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: "UPDATE linked_accounts SET label = ? WHERE user_id = ? AND id = ?", args: [label, userId, id] });
}

export async function updatePlan(userId: string, id: string, plan: string | null): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: "UPDATE linked_accounts SET plan = ? WHERE user_id = ? AND id = ?", args: [plan, userId, id] });
}

export async function updateTokens(userId: string, id: string, t: TokenSet): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE linked_accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, account_id = COALESCE(?, account_id) WHERE user_id = ? AND id = ?",
    args: [encrypt(t.accessToken), t.refreshToken ? encrypt(t.refreshToken) : null, t.expiresAt ?? null, t.accountId ?? null, userId, id],
  });
}

export async function deleteAccount(userId: string, id: string): Promise<void> {
  await ensureSchema();
  await db().batch(
    [
      { sql: "DELETE FROM account_usage WHERE account_id IN (SELECT id FROM linked_accounts WHERE user_id = ? AND id = ?)", args: [userId, id] },
      { sql: "DELETE FROM linked_accounts WHERE user_id = ? AND id = ?", args: [userId, id] },
    ],
    "write",
  );
}

/** Keeps the latest usage read for a stored account, so a team's admins see it without calling the provider again. */
export async function saveUsage(id: string, usage: Usage): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "INSERT INTO account_usage (account_id, usage, fetched_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET usage = excluded.usage, fetched_at = excluded.fetched_at",
    args: [id, sealJson(usage), Date.parse(usage.fetchedAt) || Date.now()],
  });
}

/** These users' linked accounts, without tokens, each with the last usage their dashboard read. */
export async function listAccountsWithUsage(userIds: string[]): Promise<MemberAccount[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT a.*, u.usage FROM linked_accounts a LEFT JOIN account_usage u ON u.account_id = a.id
      WHERE a.user_id IN (${placeholders(userIds.length)}) ORDER BY a.position, a.added_at`,
    args: userIds,
  });
  return res.rows.map((r) => {
    const row = r as Row;
    return { ...toPublic(row), userId: String(row.user_id), usage: row.usage ? openJson<Usage>(String(row.usage)) : null };
  });
}
