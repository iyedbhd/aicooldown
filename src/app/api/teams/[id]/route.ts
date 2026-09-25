import { NextResponse } from "next/server";
import { deleteTeam, renameTeam } from "@/lib/server/teams";
import { workspace } from "@/lib/server/workspace";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The team page's data for a team, or for "me": your own computers, accounts and sessions. */
export async function GET(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, {}, async (user) => NextResponse.json(await workspace(user, id), { headers: { "Cache-Control": "no-store" } }));
}

/** Renames the team: `{ name }`. */
export async function PATCH(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user, body) => {
    await renameTeam(user.id, id, body.name);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user) => {
    await deleteTeam(user.id, id);
    return NextResponse.json({ ok: true });
  });
}
