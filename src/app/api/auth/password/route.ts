import { NextResponse } from "next/server";
import { changePassword } from "@/lib/server/auth";
import { accountRoute } from "../_shared";

export const runtime = "nodejs";

/** Change the password; every other device is signed out. */
export function POST(req: Request) {
  return accountRoute(req, async (user, body) => {
    await changePassword(req, user, body.currentPassword, body.newPassword);
    return NextResponse.json({ ok: true });
  });
}
