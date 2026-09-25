import { NextResponse } from "next/server";
import { changeSharing } from "@/lib/server/sharing";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/**
 * What you show the other owners and admins of the teams you run:
 * `{ all }`, `{ project, shared }` or `{ session, shared }` (see sharing.ts).
 */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json({ sharing: await changeSharing(user, body) }));
}
