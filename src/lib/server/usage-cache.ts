import { createHash } from "node:crypto";
import type { Provider, Usage } from "../types";

/**
 * In-memory cache of the last usage answer per token. Anthropic rate-limits
 * the usage endpoint per access token with no Retry-After and the 429 can
 * persist for hours, so every call we can avoid matters. The cache is per
 * server instance; on serverless hosts it only helps within a warm instance.
 */
const TTL_MS: Record<Provider, number> = { claude: 150_000, codex: 45_000 };
const MAX_ENTRIES = 500;

type Entry = { usage: Usage; at: number };
const cache = new Map<string, Entry>();

export function cacheKey(provider: Provider, accessToken: string, accountId?: string): string {
  return createHash("sha256").update(`${provider}\n${accessToken}\n${accountId ?? ""}`).digest("hex");
}

export function getCached(key: string, provider: Provider): { usage: Usage; fresh: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return { usage: entry.usage, fresh: Date.now() - entry.at < TTL_MS[provider] };
}

export function setCached(key: string, usage: Usage): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { usage, at: Date.now() });
}
