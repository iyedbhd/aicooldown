import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { getSessionUser } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  return NextResponse.json({ user: await getSessionUser(req) }, { headers: { "Cache-Control": "no-store" } });
}
