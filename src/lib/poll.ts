import type { Provider } from "./types";

/**
 * Anthropic rate-limits the usage endpoint per token and the 429 can stick for
 * hours; 3 minutes between calls is the interval other tools report as safe.
 */
export const POLL_INTERVAL_MS: Record<Provider, number> = { claude: 180_000, codex: 60_000 };

const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function backoffMs(hits: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, hits - 1));
}
