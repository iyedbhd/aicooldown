import { NextResponse } from "next/server";
import { takeCommands } from "@/lib/server/commands";
import { deviceFromRequest, parseActivity, parseReport, recordSync, unlinkDevice } from "@/lib/server/devices";
import { dropImages, imageRequests } from "@/lib/server/images";
import { purgeExpired } from "@/lib/server/retention";
import { claimRun, interruptRuns } from "@/lib/server/runs";
import { deviceSharing } from "@/lib/server/sharing";
import { dropTranscripts, transcriptRequests } from "@/lib/server/transcripts";
import { readBody } from "../_lib";
import { failure } from "../_session";

export const runtime = "nodejs";

/*
 * The API a connected computer calls with its own token
 * (`Authorization: Bearer`), from its AI Cooldown server, never a browser.
 */

/** How soon to check in again while someone works with the computer, or something waits for it. */
const FAST_MS = 2_000;

const notConnected = () => NextResponse.json({ error: "This computer is not connected." }, { status: 401 });

/**
 * Checking in: `{ info, activity?, busy }`. Answers with who else sees what of
 * the computer (`sharing`), the transcripts and images someone is waiting for,
 * when it lets what sessions say reach the website, the commands its owner sent, the
 * next remote session to run (when it allows them and runs none), and how
 * soon to check in again (`pollMs`, when sooner than it would).
 */
export async function POST(req: Request) {
  try {
    const device = await deviceFromRequest(req);
    if (!device) return notConnected();
    await purgeExpired();
    const body = await readBody(req);
    const { info, manage } = parseReport(body.info);
    // A report that does not parse keeps the last good one.
    await recordSync(device, info, manage, (body.activity !== undefined && parseActivity(body.activity, info.share !== "off")) || undefined);
    // Turned private: what it sent goes.
    if (info.share === "off" && device.info.share !== "off") await Promise.all([dropTranscripts(device.id), dropImages(device.id)]);
    const content = info.share !== "off";
    const [sharing, transcripts, images, commands] = await Promise.all([
      deviceSharing(device.userId, device.id),
      content ? transcriptRequests(device.id) : [],
      content ? imageRequests(device.id) : [],
      takeCommands(device.id, device.userId),
    ]);
    const busy = transcripts.length > 0 || images.length > 0 || commands.length > 0 || device.hotUntil > Date.now();
    if (body.busy === true) return NextResponse.json({ sharing, run: null, transcripts, images, commands, pollMs: busy ? FAST_MS : undefined });
    // Running nothing: whatever is still marked running there was cut off.
    await interruptRuns(device.id);
    const run = info.remote === "off" ? null : await claimRun(device);
    return NextResponse.json({ sharing, run, transcripts, images, commands, pollMs: busy || run ? FAST_MS : undefined });
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
