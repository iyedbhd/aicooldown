import { NextResponse } from "next/server";
import { fetchClaudeIdentity } from "@/lib/providers/claude";
import { codexIdentityFromTokens } from "@/lib/providers/codex";
import { errorResponse, isProvider, readBody, str } from "../_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await readBody(req);
  const provider = body.provider;
  const accessToken = str(body, "accessToken");
  if (!isProvider(provider) || !accessToken) {
    return NextResponse.json({ error: "provider and accessToken are required" }, { status: 400 });
  }
  try {
    const identity =
      provider === "claude"
        ? await fetchClaudeIdentity(accessToken)
        : codexIdentityFromTokens(accessToken, str(body, "idToken"));
    return NextResponse.json(identity);
  } catch (err) {
    return errorResponse(err);
  }
}
