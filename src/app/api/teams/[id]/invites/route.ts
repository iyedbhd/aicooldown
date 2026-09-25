import { NextResponse } from "next/server";
import { createInvite, revokeInvite } from "@/lib/server/teams";
import { publicOrigin, str } from "../../../_lib";
import { userRoute } from "../../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** A single-use invite link: `{ email?, role }`. The link is only ever shown in this answer. */
export async function POST(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user, body) => NextResponse.json(await createInvite(user.id, id, body.email, body.role, publicOrigin(req))));
}

/** Revokes an unused invite: `{ inviteId }`. */
export async function DELETE(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user, body) => {
    const inviteId = str(body, "inviteId");
    if (!inviteId) return NextResponse.json({ error: "inviteId is required" }, { status: 400 });
    await revokeInvite(user.id, id, inviteId);
    return NextResponse.json({ ok: true });
  });
}
