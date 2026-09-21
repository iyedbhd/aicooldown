import { claudePlanLabel } from "./providers/claude";
import { codexIdentityFromTokens, codexTokenExpiry } from "./providers/codex";
import type { Provider } from "./types";

export type Imported = {
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
  idToken?: string;
  /** Subscription hint found in the credentials file, if any. */
  plan?: string;
};

function parseJson(text: string, hint: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === "object") return json as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new Error(`Could not parse that as JSON. ${hint}`);
}

/**
 * Accepts either a raw access token or the CLI's credential file.
 * Refresh tokens are deliberately dropped: imported accounts are never refreshed.
 */
export function parseImport(provider: Provider, text: string): Imported {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste a token or credentials file first.");

  if (provider === "claude") {
    if (trimmed.startsWith("sk-ant-")) return { accessToken: trimmed };
    const json = parseJson(trimmed, "Paste the contents of ~/.claude/.credentials.json or an sk-ant-oat01-… token.");
    const oauth = (json.claudeAiOauth ?? json) as Record<string, unknown>;
    if (typeof oauth.accessToken !== "string") throw new Error("No accessToken found in that JSON.");
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
      plan: claudePlanLabel({
        subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
        rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : undefined,
      }),
    };
  }

  let accessToken: string;
  let idToken: string | undefined;
  let accountId: string | undefined;
  if (trimmed.startsWith("ey")) {
    accessToken = trimmed;
  } else {
    const json = parseJson(trimmed, "Paste the contents of ~/.codex/auth.json or a raw access token.");
    const tokens = (json.tokens ?? json) as Record<string, unknown>;
    if (typeof tokens.access_token !== "string") throw new Error("No tokens.access_token found in that JSON.");
    accessToken = tokens.access_token;
    idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  }
  const identity = codexIdentityFromTokens(accessToken, idToken);
  return {
    accessToken,
    idToken,
    accountId: accountId ?? identity.accountId,
    expiresAt: codexTokenExpiry(accessToken),
    plan: identity.plan,
  };
}
