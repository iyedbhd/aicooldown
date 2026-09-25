import { NextResponse } from "next/server";
import { deviceFromRequest, parseActivity, parseInfo, recordSync, unlinkDevice } from "@/lib/server/devices";
import { claimRun, interruptRuns } from "@/lib/server/runs";
import { dropTranscripts, transcriptRequests } from "@/lib/server/transcripts";
import { readBody } from "../_lib";
import { failure } from "../_session";

export const runtime = "nodejs";

/*
 * The API a connected computer calls with its own token
 * (`Authorization: Bearer`), from its AI Cooldown server, never a browser.
 */

const notConnected = () => NextResponse.json({ error: "This computer is not connected." }, { status: 401 });

/**
 * Checking in: `{ info, activity?, busy }`. Answers with the transcripts
 * someone is waiting for, when the computer shares session content, and the
 * next remote session to run, when it allows them and runs none.
 */
export async function POST(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return notConnected();
    const body = await readBody(req);
    const info = parseInfo(body.info);
    // A report that does not parse keeps the last good one.
    await recordSync(device.id, info, (body.activity !== undefined && parseActivity(body.activity, info.share)) || undefined);
    // It stopped sharing: what it shared goes.
    if (device.info.share && !info.share) await dropTranscripts(device.id);
    const transcripts = info.share ? await transcriptRequests(device.id) : [];
    if (body.busy === true) return NextResponse.json({ run: null, transcripts });
    // Running nothing: whatever is still marked running there was cut off.
    await interruptRuns(device.id);
    return NextResponse.json({ run: info.remote === "off" ? null : await claimRun(device.id, device.userId), transcripts });
  } catch (err) {
    return failure(err);
  }
}

/** The computer disconnecting itself, when its owner signs out or disconnects it there. */
export async function DELETE(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return notConnected();
    await unlinkDevice(device.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
