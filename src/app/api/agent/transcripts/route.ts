import { NextResponse } from "next/server";
import { deviceFromRequest } from "@/lib/server/devices";
import { storeTranscript } from "@/lib/server/transcripts";
import { readBody } from "../../_lib";
import { failure } from "../../_session";

export const runtime = "nodejs";

/** A session transcript someone asked this computer for: `{ tool, sessionId, events }` or `{ tool, sessionId, error }`. */
export async function POST(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return NextResponse.json({ error: "This computer is not connected." }, { status: 401 });
    await storeTranscript(device.id, await readBody(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
