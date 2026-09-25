import { NextResponse } from "next/server";
import { deviceFromRequest } from "@/lib/server/devices";
import { storeImage } from "@/lib/server/images";
import { readBody } from "../../_lib";
import { failure } from "../../_session";

export const runtime = "nodejs";

/** An image someone asked this computer for: `{ tool, sessionId, n, type, data }` (base64) or `{ tool, sessionId, n, error }`. */
export async function POST(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return NextResponse.json({ error: "This computer is not connected." }, { status: 401 });
    await storeImage(device.id, await readBody(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
