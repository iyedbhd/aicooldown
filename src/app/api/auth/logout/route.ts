import { NextResponse } from "next/server";
import { clearedCookie, destroySession, sameOrigin } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  await destroySession(req);
  return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } });
}
