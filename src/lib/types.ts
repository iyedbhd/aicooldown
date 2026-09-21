export type Provider = "claude" | "codex";

export type Account = {
  id: string;
  provider: Provider;
  label: string;
  /** Subscription label, e.g. "Max 5x", "Pro", "plus". null = looked up but unknown. */
  plan?: string | null;
  /** Present in guest mode (kept in the browser). Absent when the account is stored server-side. */
  accessToken?: string;
  /** Only kept for accounts this app signed in itself (see `owned`). */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** Codex: value for the ChatGPT-Account-Id header. */
  accountId?: string;
  /**
   * True when this app obtained the tokens through its own sign-in, so it may
   * refresh them. Tokens imported from the Claude Code / Codex CLI are never
   * refreshed: both providers rotate refresh tokens on use, and refreshing
   * here would log the CLI out.
   */
  owned: boolean;
  addedAt: number;
};

export type UsageWindow = {
  key: string;
  label: string;
  /** 0–100 */
  usedPercent: number;
  /** ISO timestamp, or null when the provider did not report one. */
  resetsAt: string | null;
  windowSeconds?: number;
  /** True when the provider says this window is the one currently limiting the account. */
  isActive?: boolean;
};

export type ModelAvailability = {
  name: string;
  available: boolean;
  /** ISO timestamp when the model becomes available again, if reported. */
  availableAt: string | null;
};

export type Usage = {
  provider: Provider;
  plan?: string;
  windows: UsageWindow[];
  /** Per-model availability (Codex `model_usage`). */
  models?: ModelAvailability[];
  /** Provider status messages worth showing, e.g. "You're out of credits". */
  notes?: string[];
  /** When the provider actually answered (may be older than the request when served from cache). */
  fetchedAt: string;
  /** True when the provider rate-limited us and this is the last good copy. */
  stale?: boolean;
};

export type Identity = {
  email?: string;
  plan?: string;
  accountId?: string;
};

export type TokenSet = Identity & {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
