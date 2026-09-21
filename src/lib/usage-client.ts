import { postJson } from "./api";
import type { Account, TokenSet, Usage } from "./types";

export type UsageState = {
  status: "loading" | "ok" | "error";
  usage?: Usage;
  error?: string;
  /** Set when the provider rate-limited this token; we back off until then. */
  rateLimitedUntil?: number;
  /** Consecutive rate-limit hits, drives the backoff. */
  rateLimitHits?: number;
  /** Earliest time the scheduler may poll this account again. */
  nextPollAt?: number;
};

export type LoadResult = {
  usage?: Usage;
  error?: string;
  rateLimited: boolean;
  /** Guest mode: refreshed tokens the browser must keep. */
  tokens?: TokenSet;
};

/**
 * Fetches usage for one account. Signed in: the server holds the tokens and
 * refreshes them. Guest: the tokens travel with the request and any refreshed
 * ones come back for the browser to store.
 */
export async function loadUsage(account: Account, mode: "local" | "remote"): Promise<LoadResult> {
  const body =
    mode === "remote"
      ? { id: account.id }
      : {
          account: {
            provider: account.provider,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            accountId: account.accountId,
            owned: account.owned,
          },
        };
  const res = await postJson<Usage & { tokens?: TokenSet }>("/api/usage", body);
  if (!res.ok) {
    if (res.status === 429) return { rateLimited: true };
    if (res.code === "signed_out") return { error: "Signed out. Sign in again to keep polling.", rateLimited: false };
    const error =
      res.status === 401
        ? account.owned
          ? "Token refresh failed. Remove this account and sign in again."
          : "Token expired or revoked. Remove this account and import it again from the CLI credentials file."
        : res.error;
    return { error, rateLimited: false };
  }
  const { tokens, ...usage } = res.data;
  return { usage, tokens, rateLimited: Boolean(usage.stale) };
}
