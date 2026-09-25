import { NextResponse } from "next/server";
import { exchangeClaudeCode } from "@/lib/providers/claude";
import { exchangeCodexCode } from "@/lib/providers/codex";
import { errorResponse, isProvider, providerThrottled, readBody, str } from "../../_lib";

export const runtime = "nodejs";

/** Exchanges a PKCE authorization code for tokens. The verifier lives in the browser. */
export async function POST(req: Request) {
  const throttled = providerThrottled(req);
  if (throttled) return throttled;
  const body = await readBody(req);
  const provider = body.provider;
  const code = str(body, "code");
  const verifier = str(body, "verifier");
  const state = str(body, "state");
  if (!isProvider(provider) || !code || !verifier || !state) {
    return NextResponse.json({ error: "provider, code, state and verifier are required" }, { status: 400 });
  }
  try {
    const tokens =
      provider === "claude" ? await exchangeClaudeCode(code, state, verifier) : await exchangeCodexCode(code, verifier);
    return NextResponse.json(tokens);
  } catch (err) {
    return errorResponse(err);
  }
}
