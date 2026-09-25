import { NextResponse } from "next/server";
import { reportCommand } from "@/lib/server/commands";
import { deviceFromRequest } from "@/lib/server/devices";
import { readBody } from "../../_lib";
import { failure } from "../../_session";

export const runtime = "nodejs";

/** How a command from its owner went: `{ id, ok, message }`. */
export async function POST(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return NextResponse.json({ error: "This computer is not connected." }, { status: 401 });
    await reportCommand(device.id, await readBody(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
