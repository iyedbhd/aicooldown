import { NextResponse } from "next/server";
import { deviceFromRequest } from "@/lib/server/devices";
import { reportRun } from "@/lib/server/runs";
import { readBody } from "../../../_lib";
import { failure } from "../../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Output and progress of a session this computer runs: `{ events, sessionId?, status?, result? }`. Answers `{ cancel }`. */
export async function POST(req: Request, { params }: Context) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return NextResponse.json({ error: "This computer is not connected." }, { status: 401 });
    const { id } = await params;
    return NextResponse.json(await reportRun(device.id, id, await readBody(req)));
  } catch (err) {
    return failure(err);
  }
}
