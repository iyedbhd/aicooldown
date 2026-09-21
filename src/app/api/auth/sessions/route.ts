import { NextResponse } from "next/server";
import { signOutOthers } from "@/lib/server/auth";
import { accountRoute } from "../_shared";

export const runtime = "nodejs";

/** Sign out every other device. */
export function DELETE(req: Request) {
  return accountRoute(req, async (user) => {
    const removed = await signOutOthers(req, user);
    return NextResponse.json({ ok: true, removed });
  });
}
