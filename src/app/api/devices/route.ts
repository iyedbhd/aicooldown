import { NextResponse } from "next/server";
import { parseInfo, registerDevice, removeDevice } from "@/lib/server/devices";
import { str } from "../_lib";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/**
 * Connects the computer an AI Cooldown copy runs on to the signed-in account:
 * `{ machineId, info }`. Called by that copy's own server with the session it
 * was signed in with; the answer carries the token it uses from then on.
 */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => {
    const { id, token } = await registerDevice(user.id, body.machineId, parseInfo(body.info));
    return NextResponse.json({ device: { id }, token, user });
  });
}

/** Removes one of your computers with the sessions run on it: `{ deviceId }`. */
export function DELETE(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => {
    const deviceId = str(body, "deviceId");
    if (!deviceId) return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
    await removeDevice(user.id, deviceId);
    return NextResponse.json({ ok: true });
  });
}
