import { NextResponse } from "next/server";
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

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ProviderError) return NextResponse.json({ error: err.message }, { status: err.status });
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 502 });
}
