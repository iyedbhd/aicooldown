import { NextResponse } from "next/server";
import { getAccount, updatePlan, updateTokens } from "@/lib/server/accounts";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { getSessionUser } from "@/lib/server/auth";
import { lookupPlan, resolveUsage, type Secrets } from "@/lib/server/usage";
import { errorResponse, isProvider, readBody, str } from "../_lib";

export const runtime = "nodejs";

/**
 * Two callers:
 *  - signed in: `{ id }` names a stored account; tokens never leave the server
 *    (the accounts server, when this copy forwards accounts there).
 *  - guest: `{ account: { provider, accessToken, ... } }` carries the tokens
 *    from the browser; refreshed tokens come back in `tokens`.
 */
export async function POST(req: Request) {
  const body = await readBody(req);

  if (typeof body.id === "string") {
    const forwarded = await forwardAccounts(req, body);
    if (forwarded) return forwarded;
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "Sign in required", code: "signed_out" }, { status: 401 });
    const stored = await getAccount(user.id, body.id);
    if (!stored) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    try {
      const { usage, tokens } = await resolveUsage(stored);
      if (tokens) await updateTokens(user.id, stored.id, tokens);
      let plan = stored.plan;
      if (plan === undefined && !usage.stale) {
        plan = await lookupPlan({ ...stored, ...tokens }).catch(() => undefined);
        if (plan) await updatePlan(user.id, stored.id, plan);
      }
      return NextResponse.json({ ...usage, plan: plan ?? usage.plan });
    } catch (err) {
      return errorResponse(err);
    }
  }

  const account = body.account;
  if (!account || typeof account !== "object") return NextResponse.json({ error: "id or account is required" }, { status: 400 });
  const a = account as Record<string, unknown>;
  const accessToken = str(a, "accessToken");
  if (!isProvider(a.provider) || !accessToken) return NextResponse.json({ error: "provider and accessToken are required" }, { status: 400 });
  const secrets: Secrets = {
    provider: a.provider,
    accessToken,
    refreshToken: str(a, "refreshToken"),
    expiresAt: typeof a.expiresAt === "number" ? a.expiresAt : undefined,
    accountId: str(a, "accountId"),
    owned: a.owned === true,
  };
  try {
    const { usage, tokens } = await resolveUsage(secrets);
    return NextResponse.json(tokens ? { ...usage, tokens } : usage);
  } catch (err) {
    return errorResponse(err);
  }
}
