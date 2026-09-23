import { ProviderError, type BankedResets, type Identity, type TokenSet, type Usage, type UsageWindow } from "../types";

// Same public OAuth client Claude Code uses (PKCE, no secret).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// cedar_ember=1 adds the banked-reset grants to the same response.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";

function apiHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    // Without a claude-code User-Agent the usage endpoint answers from a
    // heavily rate-limited bucket and returns persistent 429s. Even with it,
    // the limit is per access token: keep calls at least ~3 minutes apart.
    "User-Agent": "claude-code/2.1.27",
    Accept: "application/json",
  };
}

/** Client-side: URL for the manual "copy the code" sign-in flow. */
export function claudeAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session (5h)",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · OAuth apps",
  seven_day_routines: "Weekly · Routines",
  seven_day_cowork: "Weekly · Cowork",
};

const WINDOW_ORDER = ["five_hour", "seven_day"];

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function toWindow(key: string, value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.utilization !== "number") return null;
  return {
    key,
    label: WINDOW_LABELS[key] ?? humanize(key),
    usedPercent: Math.max(0, Math.min(100, v.utilization)),
    resetsAt: typeof v.resets_at === "string" ? v.resets_at : null,
    windowSeconds: key === "five_hour" ? 5 * 3600 : key.startsWith("seven_day") ? 7 * 86400 : undefined,
  };
}

/**
 * Entry of the structured `limits[]` array. On migrated accounts this is the
 * only place model-scoped weekly limits (e.g. Fable) appear; the flat
 * `seven_day_<model>` keys come back null there.
 */
type LimitEntry = {
  kind?: string; // "session" | "weekly_all" | "weekly_scoped" | …
  percent?: number;
  is_active?: boolean;
  resets_at?: string;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: string | null } | null;
};

function windowsFromLimits(limits: LimitEntry[], json: Record<string, unknown>): UsageWindow[] {
  const flatReset = (key: string): string | null => {
    const v = json[key] as { resets_at?: unknown } | null | undefined;
    return typeof v?.resets_at === "string" ? v.resets_at : null;
  };
  const windows: UsageWindow[] = [];
  limits.forEach((l, i) => {
    if (typeof l.percent !== "number") return;
    let key: string;
    let label: string;
    let fallbackReset: string | null = null;
    let windowSeconds: number | undefined;
    switch (l.kind) {
      case "session":
        key = "five_hour";
        label = WINDOW_LABELS.five_hour;
        fallbackReset = flatReset("five_hour");
        windowSeconds = 5 * 3600;
        break;
      case "weekly_all":
        key = "seven_day";
        label = WINDOW_LABELS.seven_day;
        fallbackReset = flatReset("seven_day");
        windowSeconds = 7 * 86400;
        break;
      case "weekly_scoped": {
        const name = l.scope?.model?.display_name ?? l.scope?.model?.id ?? l.scope?.surface ?? `scoped ${i}`;
        key = `weekly_${name.toLowerCase().replace(/\s+/g, "_")}`;
        label = `Weekly · ${name}`;
        fallbackReset = flatReset("seven_day");
        windowSeconds = 7 * 86400;
        break;
      }
      default:
        key = l.kind ?? `limit_${i}`;
        label = humanize(key);
    }
    if (windows.some((w) => w.key === key)) return;
    windows.push({
      key,
      label,
      usedPercent: Math.max(0, Math.min(100, l.percent)),
      resetsAt: l.resets_at ?? fallbackReset,
      windowSeconds,
      isActive: l.is_active === true,
    });
  });
  return windows;
}

function windowsFromFlatKeys(json: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (key === "limits") continue;
    const w = toWindow(key, value);
    if (w) windows.push(w);
  }
  return windows;
}

type Grant = { resets_left?: unknown; ends_at?: unknown; paused?: unknown };

/**
 * Banked resets (the CLI's `cedar_ember` program): grants of one or more
 * resets each. Paused or lapsed grants cannot be claimed and do not count.
 */
function bankedResets(block: unknown, now: number): BankedResets | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as { eligible?: unknown; grants?: unknown };
  if (b.eligible !== true || !Array.isArray(b.grants)) return undefined;
  let available = 0;
  let nextExpiresAt: string | null = null;
  for (const raw of b.grants as Grant[]) {
    if (!raw || typeof raw.resets_left !== "number" || raw.resets_left <= 0 || raw.paused === true) continue;
    const ends = typeof raw.ends_at === "string" ? Date.parse(raw.ends_at) : NaN;
    if (!Number.isNaN(ends) && ends <= now) continue;
    available += raw.resets_left;
    if (!Number.isNaN(ends) && (nextExpiresAt === null || ends < Date.parse(nextExpiresAt))) nextExpiresAt = new Date(ends).toISOString();
  }
  return available > 0 ? { available, nextExpiresAt } : undefined;
}

function normalizeUsage(json: Record<string, unknown>): Usage {
  const limits = Array.isArray(json.limits) ? (json.limits as LimitEntry[]) : [];
  const windows = limits.length > 0 ? windowsFromLimits(limits, json) : windowsFromFlatKeys(json);
  windows.sort((a, b) => {
    const ia = WINDOW_ORDER.indexOf(a.key);
    const ib = WINDOW_ORDER.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return { provider: "claude", windows, bankedResets: bankedResets(json.cedar_ember, Date.now()), fetchedAt: new Date().toISOString() };
}

async function readError(res: Response): Promise<string> {
  if (res.status === 401) return "Token rejected (expired or revoked).";
  if (res.status === 429) return "Rate limited by Anthropic. Try again in a few minutes.";
  return describeErrorBody(await res.text().catch(() => ""), res);
}

/** Pulls a human-readable message out of the provider's error JSON. */
export function describeErrorBody(text: string, res: Response): string {
  try {
    const json = JSON.parse(text) as { error_description?: string; error?: string | { message?: string }; message?: string };
    const message =
      json.error_description ??
      (typeof json.error === "object" ? json.error?.message : json.error) ??
      json.message;
    if (typeof message === "string" && message) return message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || res.statusText || `HTTP ${res.status}`;
}

export async function fetchClaudeUsage(accessToken: string): Promise<Usage> {
  const res = await fetch(USAGE_URL, { headers: apiHeaders(accessToken), cache: "no-store" });
  if (!res.ok) throw new ProviderError(res.status, await readError(res));
  return normalizeUsage((await res.json()) as Record<string, unknown>);
}

/**
 * Builds a subscription label such as "Max 5x", "Pro" or "Team" from the
 * fields Anthropic exposes (profile endpoint or the CLI credentials file).
 */
export function claudePlanLabel(input: {
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  hasMax?: boolean;
  hasPro?: boolean;
}): string | undefined {
  const tier = input.rateLimitTier ?? "";
  const multiplier = tier.match(/(\d+)x/)?.[1];
  const base =
    input.subscriptionType?.trim() || (input.hasMax ? "max" : input.hasPro ? "pro" : tier.replace(/^default_/, "").replace(/_?claude_?/, "").replace(/_\d+x$/, ""));
  if (!base) return undefined;
  const pretty = base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return multiplier && !/\d+x/.test(pretty) ? `${pretty} ${multiplier}x` : pretty;
}

function findString(obj: unknown, pattern: RegExp, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 3) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (pattern.test(k) && typeof v === "string") return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findString(v, pattern, depth + 1);
    if (found) return found;
  }
  return undefined;
}

type Profile = {
  account?: { uuid?: string; email?: string; email_address?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { uuid?: string };
};

async function fetchProfile(accessToken: string): Promise<Profile> {
  const res = await fetch(PROFILE_URL, { headers: apiHeaders(accessToken), cache: "no-store" });
  if (!res.ok) throw new ProviderError(res.status, await readError(res));
  return (await res.json()) as Profile;
}

// The profile names it `email`; token responses name it `email_address`.
const profileEmail = (json: Profile) => json.account?.email ?? json.account?.email_address;

export async function fetchClaudeIdentity(accessToken: string): Promise<Identity> {
  const json = await fetchProfile(accessToken);
  const plan = claudePlanLabel({
    subscriptionType: findString(json, /^subscription_?type$/i),
    rateLimitTier: findString(json, /^rate_?limit_?tier$/i),
    hasMax: json.account?.has_claude_max,
    hasPro: json.account?.has_claude_pro,
  });
  return { email: profileEmail(json), plan };
}

/** Whose token this is: the account and organization Claude Code keeps as oauthAccount in .claude.json. */
export async function fetchClaudeAccount(accessToken: string): Promise<{ accountUuid?: string; organizationUuid?: string; email?: string }> {
  const json = await fetchProfile(accessToken);
  return { accountUuid: json.account?.uuid, organizationUuid: json.organization?.uuid, email: profileEmail(json) };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  if (!res.ok) throw new ProviderError(res.status, await readError(res));
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new ProviderError(502, "Token response had no access_token.");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

/** `code` may be pasted as `code#state`; the part after `#` is the state. */
export async function exchangeClaudeCode(code: string, state: string, verifier: string): Promise<TokenSet> {
  const [authCode, pastedState] = code.trim().split("#");
  if (pastedState && pastedState !== state) throw new ProviderError(400, "State mismatch. Start the sign-in again.");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: authCode,
    state,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const identity = await fetchClaudeIdentity(tokens.accessToken).catch(() => ({}));
  return { ...tokens, ...identity };
}

export function refreshClaudeTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });
}
