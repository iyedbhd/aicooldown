import { fetchClaudeIdentity, fetchClaudeUsage, refreshClaudeTokens } from "../providers/claude";
import { codexIdentityFromTokens, fetchCodexUsage, refreshCodexTokens } from "../providers/codex";
import { ProviderError, type Provider, type TokenSet, type Usage } from "../types";
import { cacheKey, getCached, setCached } from "./usage-cache";

export type Secrets = {
  provider: Provider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  /** Only owned sessions may be refreshed; imported CLI tokens must not be. */
  owned: boolean;
};

export type Resolved = { usage: Usage; tokens?: TokenSet };

const REFRESH_AHEAD_MS = 5 * 60_000;

function refresh(s: Secrets): Promise<TokenSet> {
  if (!s.refreshToken) throw new ProviderError(401, "No refresh token.");
  return s.provider === "claude" ? refreshClaudeTokens(s.refreshToken) : refreshCodexTokens(s.refreshToken);
}

async function fetchWithCache(s: Secrets): Promise<Usage> {
  const key = cacheKey(s.provider, s.accessToken, s.accountId);
  const cached = getCached(key, s.provider);
  if (cached?.fresh) return cached.usage;
  try {
    const usage = s.provider === "claude" ? await fetchClaudeUsage(s.accessToken) : await fetchCodexUsage(s.accessToken, s.accountId);
    setCached(key, usage);
    return usage;
  } catch (err) {
    if (err instanceof ProviderError && err.status === 429 && cached) return { ...cached.usage, stale: true };
    throw err;
  }
}

/**
 * Usage for one account, refreshing owned tokens when they are about to
 * expire or get rejected. Returns the new tokens so the caller can persist
 * them (server store or the guest's browser).
 */
export async function resolveUsage(s: Secrets): Promise<Resolved> {
  const canRefresh = s.owned && Boolean(s.refreshToken);
  let current = s;
  let tokens: TokenSet | undefined;

  if (canRefresh && current.expiresAt !== undefined && current.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
    try {
      tokens = await refresh(current);
      current = { ...current, ...tokens, refreshToken: tokens.refreshToken ?? current.refreshToken };
    } catch {
      /* try the existing token */
    }
  }

  try {
    return { usage: await fetchWithCache(current), tokens };
  } catch (err) {
    if (!(err instanceof ProviderError && err.status === 401 && canRefresh && !tokens)) throw err;
    tokens = await refresh(current); // throws a ProviderError the route maps to a response
    current = { ...current, ...tokens, refreshToken: tokens.refreshToken ?? current.refreshToken };
    return { usage: await fetchWithCache(current), tokens };
  }
}

/** Subscription label for a token; network for Claude, JWT claims for Codex. */
export async function lookupPlan(s: Secrets): Promise<string | undefined> {
  if (s.provider === "codex") return codexIdentityFromTokens(s.accessToken).plan;
  return (await fetchClaudeIdentity(s.accessToken)).plan;
}
