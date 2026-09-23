import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { clearedCookie, destroySession, sameOrigin } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  await destroySession(req);
  return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } });
}
