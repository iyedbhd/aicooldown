import { decodeJwtPayload } from "../jwt";
import { describeErrorBody } from "./claude";
import {
  ProviderError,
  type BankedResets,
  type Identity,
  type ModelAvailability,
  type TokenSet,
  type Usage,
  type UsageWindow,
} from "../types";

// Same public OAuth client the Codex CLI uses (PKCE, no secret).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const SCOPES = "openid profile email offline_access";

/** Client-side: the browser will land on localhost:1455, and the user pastes that URL back. */
export function codexAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Identity is embedded in the JWT claims; no network call needed. */
export function codexIdentityFromTokens(accessToken: string, idToken?: string): Identity {
  const access = decodeJwtPayload(accessToken) ?? {};
  const id = idToken ? (decodeJwtPayload(idToken) ?? {}) : {};
  const auth = ((id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"]) ?? {}) as Record<
    string,
    unknown
  >;
  const profile = (access["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
  const email = [id.email, profile.email].find((e): e is string => typeof e === "string");
  return {
    email,
    plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
    accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
  };
}

export function codexTokenExpiry(accessToken: string): number | undefined {
  const exp = decodeJwtPayload(accessToken)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

type RateWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === 18000) return "Session (5h)";
  if (seconds === 604800) return "Weekly";
  if (seconds) return `${Math.round(seconds / 3600)}h window`;
  return fallback;
}

function toWindow(key: string, w: RateWindow | null | undefined, fallbackLabel: string, prefix = ""): UsageWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  let resetsAt: string | null = null;
  if (typeof w.reset_at === "number") resetsAt = new Date(w.reset_at * 1000).toISOString();
  else if (typeof w.reset_after_seconds === "number") resetsAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  return {
    key,
    label: prefix + windowLabel(w.limit_window_seconds, fallbackLabel),
    usedPercent: Math.max(0, Math.min(100, w.used_percent)),
    resetsAt,
    windowSeconds: w.limit_window_seconds,
  };
}

function normalizeUsage(json: Record<string, unknown>): Usage {
  const windows: UsageWindow[] = [];
  const rl = (json.rate_limit ?? {}) as {
    primary_window?: RateWindow | null;
    secondary_window?: RateWindow | null;
    limit_reached?: boolean;
  };
  const primary = toWindow("primary", rl.primary_window, "Primary");
  const secondary = toWindow("secondary", rl.secondary_window, "Secondary");
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);

  const additional = Array.isArray(json.additional_rate_limits) ? json.additional_rate_limits : [];
  additional.forEach((item, i) => {
    const it = (item ?? {}) as Record<string, unknown>;
    const name = [it.name, it.model, it.limit_name].find((n): n is string => typeof n === "string") ?? `Limit ${i + 1}`;
    const inner = (it.rate_limit ?? {}) as { primary_window?: RateWindow; secondary_window?: RateWindow };
    const p = toWindow(`extra_${i}_primary`, inner.primary_window, "Primary", `${name} · `);
    const s = toWindow(`extra_${i}_secondary`, inner.secondary_window, "Secondary", `${name} · `);
    if (p) windows.push(p);
    if (s) windows.push(s);
  });

  const models: ModelAvailability[] = [];
  const modelUsage = json.model_usage;
  if (modelUsage && typeof modelUsage === "object") {
    for (const [name, value] of Object.entries(modelUsage as Record<string, unknown>)) {
      const v = (value ?? {}) as { available?: boolean; available_at?: string };
      models.push({ name, available: v.available !== false, availableAt: typeof v.available_at === "string" ? v.available_at : null });
    }
  }

  const notes: string[] = [];
  const upsell = json.rate_limit_upsell as { title?: string; description?: string } | null | undefined;
  if (rl.limit_reached && upsell?.title) notes.push(upsell.description ? `${upsell.title}. ${upsell.description}` : upsell.title);
  const credits = json.credits as { unlimited?: boolean; balance?: number | string | null } | undefined;
  if (credits?.unlimited) notes.push("Unlimited credits");
  else if (credits?.balance !== null && credits?.balance !== undefined) notes.push(`Credits balance: ${credits.balance}`);

  const resetCredits = json.rate_limit_reset_credits as { available_count?: unknown } | null | undefined;
  const banked = typeof resetCredits?.available_count === "number" && resetCredits.available_count > 0 ? resetCredits.available_count : 0;

  return {
    provider: "codex",
    plan: typeof json.plan_type === "string" ? json.plan_type : undefined,
    windows,
    bankedResets: banked ? { available: banked, nextExpiresAt: null } : undefined,
    models: models.length ? models : undefined,
    notes: notes.length ? notes : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

async function readError(res: Response): Promise<string> {
  if (res.status === 401) return "Token rejected (expired or revoked).";
  if (res.status === 429) return "Rate limited by OpenAI. Try again in a few minutes.";
  return describeErrorBody(await res.text().catch(() => ""), res);
}

export async function fetchCodexUsage(accessToken: string, accountId?: string): Promise<Usage> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "aicooldown",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const res = await fetch(USAGE_URL, { headers, cache: "no-store" });
  if (!res.ok) throw new ProviderError(res.status, await readError(res));
  const usage = normalizeUsage((await res.json()) as Record<string, unknown>);
  if (usage.bankedResets) usage.bankedResets = await withResetExpiry(usage.bankedResets, headers);
  return usage;
}

type ResetCredit = { status?: unknown; expires_at?: unknown };

/**
 * The usage response only counts banked resets; their expiry (30 days from
 * the grant) needs the credit list. Best effort: the count stands on its own.
 */
async function withResetExpiry(banked: BankedResets, headers: Record<string, string>): Promise<BankedResets> {
  try {
    const res = await fetch(RESET_CREDITS_URL, { headers, cache: "no-store" });
    if (!res.ok) return banked;
    const json = (await res.json()) as { credits?: ResetCredit[] };
    const now = Date.now();
    const live = (json.credits ?? []).filter((c) => typeof c.expires_at === "string" && Date.parse(c.expires_at) > now);
    const available = live.filter((c) => c.status === "available");
    const soonest = (available.length ? available : live).map((c) => Date.parse(c.expires_at as string)).sort((a, b) => a - b)[0];
    return soonest ? { ...banked, nextExpiresAt: new Date(soonest).toISOString() } : banked;
  } catch {
    return banked;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  if (!res.ok) throw new ProviderError(res.status, await readError(res));
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!json.access_token) throw new ProviderError(502, "Token response had no access_token.");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: codexTokenExpiry(json.access_token),
    ...codexIdentityFromTokens(json.access_token, json.id_token),
  };
}

export function exchangeCodexCode(code: string, verifier: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
}

export function refreshCodexTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });
}
