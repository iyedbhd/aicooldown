import { NextResponse } from "next/server";
import { createRun } from "@/lib/server/runs";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/** Queues a Claude Code session on a computer: `{ deviceId, project, prompt, mode, model, resume }`. */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json({ run: await createRun(user, body) }));
}
