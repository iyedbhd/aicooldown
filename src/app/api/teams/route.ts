import { NextResponse } from "next/server";
import { createTeam, listTeams } from "@/lib/server/teams";
import { userRoute } from "../_session";

export const runtime = "nodejs";

/** The teams you are in. */
export function GET(req: Request) {
  return userRoute(req, {}, async (user) => NextResponse.json({ teams: await listTeams(user.id) }, { headers: { "Cache-Control": "no-store" } }));
}

/** A new team, with you as its owner: `{ name }`. */
export function POST(req: Request) {
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json({ team: await createTeam(user.id, body.name) }));
}
