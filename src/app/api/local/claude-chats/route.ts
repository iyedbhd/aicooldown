import { NextResponse } from "next/server";
import { claudeAppState, copyChats, isAccountId, isChatId, isOperationId, isPlace, nameAccount, undoChats } from "@/lib/server/local/claude-app";
import { localRequestAllowed } from "@/lib/server/local/gate";
import { readBody } from "../../_lib";

export const runtime = "nodejs";

/** Chats one request may copy or move. */
const MAX_CHATS = 1000;

/** 404 everywhere but a copy running on the user's own machine, like the rest of the local features. */
const notHere = () => NextResponse.json({ error: "Not available" }, { status: 404 });
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** The Claude app's chats on this computer, per account, and what was copied where. */
export async function GET(req: Request) {
  if (!localRequestAllowed(req)) return notHere();
  return NextResponse.json(await claudeAppState(), { headers: { "Cache-Control": "no-store" } });
}

/** Copies or moves chats between accounts, undoes that, or names an account. */
export async function POST(req: Request) {
  if (!localRequestAllowed(req)) return notHere();
  // A JSON content type forces a CORS preflight, which no other site gets past.
  if (!req.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  const body = await readBody(req);
  try {
    let result = null;
    if (body.action === "copy" || body.action === "move") {
      const chats = body.chats;
      if (!isPlace(body.from) || !isPlace(body.to)) return bad("from and to are required");
      if (body.from.account === body.to.account && body.from.org === body.to.org) return bad("Pick another account to copy to.");
      if (!Array.isArray(chats) || chats.length === 0 || chats.length > MAX_CHATS || !chats.every(isChatId)) return bad("chats are required");
      result = await copyChats(body.from, body.to, chats, body.action === "move");
    } else if (body.action === "undo") {
      if (!isOperationId(body.operation)) return bad("operation is required");
      result = await undoChats(body.operation);
    } else if (body.action === "name") {
      if (!isAccountId(body.account) || (body.name !== null && typeof body.name !== "string")) return bad("account and name are required");
      await nameAccount(body.account, body.name);
    } else return bad("Unknown action");
    return NextResponse.json({ state: await claudeAppState(), result });
  } catch (err) {
    // What went wrong, as it is: only this computer's own user sees it.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 502 });
  }
}
