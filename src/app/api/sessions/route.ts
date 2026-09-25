import { NextResponse } from "next/server";
import { getTranscript, requestTranscript } from "@/lib/server/transcripts";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/** A session's transcript as it stands: `?deviceId&tool&sessionId`. */
export function GET(req: Request) {
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return userRoute(req, {}, async (user) => NextResponse.json(await getTranscript(user, query), { headers: { "Cache-Control": "no-store" } }));
}

/** Asks the session's computer for its transcript: `{ deviceId, tool, sessionId, refresh }`. */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json(await requestTranscript(user, body)));
}
