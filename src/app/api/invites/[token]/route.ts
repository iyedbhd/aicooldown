import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { acceptInvite, previewInvite } from "@/lib/server/teams";
import { failure, userRoute } from "../../_session";

export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };

/** Which team an invite link is for, shown before signing in to accept it. */
export async function GET(req: Request, { params }: Context) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  const { token } = await params;
  try {
    return NextResponse.json(await previewInvite(token), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}

/** Joins the team as the signed-in user, and uses the invite up. */
export async function POST(req: Request, { params }: Context) {
  const { token } = await params;
  return userRoute(req, { write: true }, async (user) => NextResponse.json({ teamId: await acceptInvite(user, token) }));
}
