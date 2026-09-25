import { NextResponse } from "next/server";
import { createAccount, deleteAccount, listAccounts, updateLabel, type NewStoredAccount } from "@/lib/server/accounts";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { getSessionUser, sameOrigin } from "@/lib/server/auth";
import { lookupPlan } from "@/lib/server/usage";
import { isProvider, readBody, str } from "../_lib";

export const runtime = "nodejs";

async function requireUser(req: Request) {
  const user = await getSessionUser(req);
  if (!user) return null;
  return user;
}

export async function GET(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.json({ accounts: await listAccounts(user.id) });
}

/** Linked accounts one user may keep. */
const MAX_ACCOUNTS = 50;
/** Longer than any provider's tokens: what does not fit is not a token. */
const MAX_TOKEN = 10_000;

function parseNew(raw: unknown): NewStoredAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const accessToken = str(a, "accessToken");
  const refreshToken = str(a, "refreshToken");
  const label = str(a, "label");
  if (!isProvider(a.provider) || !accessToken || !label) return null;
  if (accessToken.length > MAX_TOKEN || (refreshToken?.length ?? 0) > MAX_TOKEN) return null;
  return {
    provider: a.provider,
    label: label.slice(0, 120),
    plan: typeof a.plan === "string" ? a.plan.slice(0, 60) : undefined,
    accessToken,
    refreshToken,
    expiresAt: typeof a.expiresAt === "number" ? a.expiresAt : undefined,
    accountId: str(a, "accountId")?.slice(0, 200),
    owned: a.owned === true,
  };
}

/** Creates one account (`{ account }`) or several (`{ accounts: [...] }`, used to import guest data). */
export async function POST(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readBody(req);
  const raws = Array.isArray(body.accounts) ? body.accounts : [body.account];
  const parsed = raws.map(parseNew);
  if (parsed.some((p) => p === null) || parsed.length === 0 || parsed.length > MAX_ACCOUNTS) {
    return NextResponse.json({ error: "Each account needs provider, label and accessToken" }, { status: 400 });
  }
  if ((await listAccounts(user.id)).length + parsed.length > MAX_ACCOUNTS) {
    return NextResponse.json({ error: `An account keeps up to ${MAX_ACCOUNTS} linked accounts. Remove some first.` }, { status: 409 });
  }
  const created = [];
  for (const a of parsed as NewStoredAccount[]) {
    if (a.plan === undefined) a.plan = await lookupPlan(a).catch(() => undefined);
    created.push(await createAccount(user.id, a));
  }
  return NextResponse.json({ accounts: created });
}

export async function PATCH(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readBody(req);
  const id = str(body, "id");
  const label = str(body, "label");
  if (!id || !label) return NextResponse.json({ error: "id and label are required" }, { status: 400 });
  await updateLabel(user.id, id, label.slice(0, 120));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readBody(req);
  const id = str(body, "id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
