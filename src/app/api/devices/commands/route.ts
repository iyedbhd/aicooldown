import { NextResponse } from "next/server";
import { createCommand } from "@/lib/server/commands";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

/** Has one of your computers switch or save a CLI login, or say hello now or on a schedule: `{ deviceId, kind, ... }`. */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json({ command: await createCommand(user, body) }));
}
