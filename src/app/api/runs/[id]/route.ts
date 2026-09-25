import { NextResponse } from "next/server";
import { cancelRun, getRun } from "@/lib/server/runs";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The session and its output after `?after=<seq>`. */
export async function GET(req: Request, { params }: Context) {
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after")) || 0;
  return userRoute(req, {}, async (user) => NextResponse.json(await getRun(user, id, after), { headers: { "Cache-Control": "no-store" } }));
}

/** Cancels the session. */
export async function DELETE(req: Request, { params }: Context) {
  const { id } = await params;
  return userRoute(req, { write: true }, async (user) => {
    await cancelRun(user, id);
    return NextResponse.json({ ok: true });
  });
}
