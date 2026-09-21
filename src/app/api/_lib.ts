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

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ProviderError) return NextResponse.json({ error: err.message }, { status: err.status });
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 502 });
}
