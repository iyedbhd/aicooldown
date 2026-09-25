import { NextResponse } from "next/server";
import { adminOver } from "@/lib/server/teams";
import { deviceById, heatDevice } from "@/lib/server/devices";
import { RequestError } from "@/lib/server/request-error";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

/**
 * Someone has a conversation on this computer open: it checks in every few
 * seconds for a while, so a message starts at once. `{ deviceId }`.
 */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => {
    const device = typeof body.deviceId === "string" ? await deviceById(body.deviceId) : null;
    if (!device || !(await adminOver(user.id, device.userId))) throw new RequestError(404, "Computer not found.");
    await heatDevice(device.id);
    return NextResponse.json({ ok: true });
  });
}
