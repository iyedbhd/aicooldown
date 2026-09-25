import { NextResponse } from "next/server";
import { imageStates, requestImages } from "@/lib/server/images";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

/** Where some images of a session stand: `?deviceId&tool&sessionId&n=1,2,3`. */
export function GET(req: Request) {
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return userRoute(req, {}, async (user) => NextResponse.json({ images: await imageStates(user, query) }, { headers: { "Cache-Control": "no-store" } }));
}

/** Asks the session's computer for some of its images: `{ deviceId, tool, sessionId, n: number[], retry? }`. */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json({ images: await requestImages(user, body) }));
}
