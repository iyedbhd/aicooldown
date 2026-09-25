import { NextResponse } from "next/server";
import { throttle } from "@/lib/server/auth";
import { ProviderError, type Provider } from "@/lib/types";

export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex";
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const json: unknown = await req.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** This server's address as the browser sees it, for links it hands out. Only Vercel's own proxy is trusted to say it with x-forwarded-host. */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = (process.env.VERCEL ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.slice(0, -1);
  return `${proto}://${host}`;
}

/**
 * The provider endpoints anyone may call, without an account, are throttled
 * per IP: enough for a dashboard polling a handful of accounts, not for
 * trying tokens in bulk through this server.
 */
export const providerThrottled = (req: Request) =>
  throttle(req, "providers", 600) ? null : NextResponse.json({ error: "Too many requests from here. Try again in a few minutes." }, { status: 429 });

/** A provider's refusal as its status and message; anything else as a 502 that keeps the server's insides to its log. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ProviderError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("[api]", err);
  return NextResponse.json({ error: "Could not get an answer from the provider. Try again in a moment." }, { status: 502 });
}
