import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return NextResponse.json({ user: await getSessionUser(req) }, { headers: { "Cache-Control": "no-store" } });
}
