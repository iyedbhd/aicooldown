import { NextResponse } from "next/server";
import { removeMember, setRole } from "@/lib/server/teams";
import { str } from "../../../_lib";
import { userRoute } from "../../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Changes someone's role: `{ userId, role }`. */
export async function PATCH(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user, body) => {
    const userId = str(body, "userId");
    if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
    await setRole(user.id, id, userId, body.role);
    return NextResponse.json({ ok: true });
  });
}

/** Removes someone from the team, or leaves it when `userId` is yours: `{ userId }`. */
export async function DELETE(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user, body) => {
    const userId = str(body, "userId");
    if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
    await removeMember(user.id, id, userId);
    return NextResponse.json({ ok: true });
  });
}
