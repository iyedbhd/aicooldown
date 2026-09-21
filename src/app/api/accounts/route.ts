import { NextResponse } from "next/server";
import { createAccount, deleteAccount, listAccounts, updateLabel, type NewStoredAccount } from "@/lib/server/accounts";
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
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.json({ accounts: await listAccounts(user.id) });
}

function parseNew(raw: unknown): NewStoredAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const accessToken = str(a, "accessToken");
  const label = str(a, "label");
  if (!isProvider(a.provider) || !accessToken || !label) return null;
  return {
    provider: a.provider,
    label: label.slice(0, 120),
    plan: typeof a.plan === "string" ? a.plan : undefined,
    accessToken,
    refreshToken: str(a, "refreshToken"),
    expiresAt: typeof a.expiresAt === "number" ? a.expiresAt : undefined,
    accountId: str(a, "accountId"),
    owned: a.owned === true,
  };
}

/** Creates one account (`{ account }`) or several (`{ accounts: [...] }`, used to import guest data). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readBody(req);
  const raws = Array.isArray(body.accounts) ? body.accounts : [body.account];
  const parsed = raws.map(parseNew);
  if (parsed.some((p) => p === null) || parsed.length === 0 || parsed.length > 50) {
    return NextResponse.json({ error: "Each account needs provider, label and accessToken" }, { status: 400 });
  }
  const created = [];
  for (const a of parsed as NewStoredAccount[]) {
    if (a.plan === undefined) a.plan = await lookupPlan(a).catch(() => undefined);
    created.push(await createAccount(user.id, a));
  }
  return NextResponse.json({ accounts: created });
}

export async function PATCH(req: Request) {
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
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readBody(req);
  const id = str(body, "id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
