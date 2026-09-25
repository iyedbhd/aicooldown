import { NextResponse } from "next/server";
import type { ScheduleMode } from "@/lib/local";
import { connect, disconnect, setRemote, setShare, startAgent, stopRun } from "@/lib/server/local/device";
import { localRequestAllowed } from "@/lib/server/local/gate";
import { actions, localState, startScheduler } from "@/lib/server/local/schedule";
import { REMOTE_LEVELS, SHARE_LEVELS, type RemoteLevel, type ShareLevel } from "@/lib/team";
import { ProviderError } from "@/lib/types";
import { isProvider, readBody, str } from "../_lib";

export const runtime = "nodejs";

const MODES: ScheduleMode[] = ["at", "reset", "every-reset"];

/** 404 everywhere but a copy running on the user's own machine, so the panel never shows on the hosted site. */
const notHere = () => NextResponse.json({ error: "Not available" }, { status: 404 });

/** What went wrong, as it is: only this computer's own user sees it. */
function localError(err: unknown): NextResponse {
  return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: err instanceof ProviderError ? err.status : 502 });
}

export async function GET(req: Request) {
  if (!localRequestAllowed(req)) return notHere();
  await startScheduler();
  startAgent();
  return NextResponse.json(await localState());
}

export async function POST(req: Request) {
  if (!localRequestAllowed(req)) return notHere();
  // A JSON content type forces a CORS preflight, which no other site gets past.
  if (!req.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  await startScheduler();
  startAgent();
  const body = await readBody(req);
  const profileId = str(body, "profileId");
  try {
    switch (body.action) {
      case "save":
        if (!isProvider(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });
        await actions.save(body.provider);
        break;
      case "switch":
      case "forget":
      case "hello":
        if (!profileId) return NextResponse.json({ error: "profileId is required" }, { status: 400 });
        await actions[body.action](profileId);
        break;
      case "schedule": {
        const mode = body.mode as ScheduleMode;
        if (!profileId || !MODES.includes(mode)) return NextResponse.json({ error: "profileId and mode are required" }, { status: 400 });
        await actions.schedule(profileId, mode, typeof body.at === "number" ? body.at : undefined);
        break;
      }
      case "cancel": {
        const scheduleId = str(body, "scheduleId");
        if (!scheduleId) return NextResponse.json({ error: "scheduleId is required" }, { status: 400 });
        await actions.cancel(scheduleId);
        break;
      }
      case "connect":
        await connect(req);
        break;
      case "disconnect":
        await disconnect(body.forget !== false);
        break;
      case "remote":
        if (!REMOTE_LEVELS.includes(body.level as RemoteLevel)) return NextResponse.json({ error: "level is required" }, { status: 400 });
        await setRemote(body.level as RemoteLevel);
        break;
      case "share":
        if (!SHARE_LEVELS.includes(body.level as ShareLevel)) return NextResponse.json({ error: "level is required" }, { status: 400 });
        await setShare(body.level as ShareLevel);
        break;
      case "stop-run":
        stopRun();
        break;
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json(await localState());
  } catch (err) {
    return localError(err);
  }
}
