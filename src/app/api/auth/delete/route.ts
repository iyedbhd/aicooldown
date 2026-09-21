import { NextResponse } from "next/server";
import { clearedCookie, deleteAccount } from "@/lib/server/auth";
import { accountRoute } from "../_shared";

export const runtime = "nodejs";

/** Delete the account, its sessions and its linked provider accounts. Needs the password. */
export function POST(req: Request) {
  return accountRoute(req, async (user, body) => {
    await deleteAccount(user, body.password);
    return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } });
  });
}
