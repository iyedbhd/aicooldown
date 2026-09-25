import { NextResponse } from "next/server";
import { changeSharing, summaryOf } from "@/lib/server/sharing";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/**
 * What you share, and with whom: `{ all }`, or `{ project, audience, shared }`
 * or `{ session, audience, shared }` (see sharing.ts).
 */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => {
    const shares = await changeSharing(user, body);
    // `sharing` as the desktop app's pages up to 0.8 read it; `shares` in full.
    return NextResponse.json({ shares, sharing: summaryOf(shares) });
  });
}
