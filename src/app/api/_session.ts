import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { getSessionUser, sameOrigin, throttle, type User } from "@/lib/server/auth";
import { RequestError } from "@/lib/server/request-error";
import { readBody } from "./_lib";

type Options = {
  /** Changes something: refused from other sites. */
  write?: boolean;
  /** Guards a password: a few attempts per IP. */
  throttle?: boolean;
};

/** A RequestError as its status and message; anything else as a 500. */
export function failure(err: unknown): NextResponse {
  if (err instanceof RequestError) return NextResponse.json({ error: err.message }, { status: err.status });
  return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
}

/**
 * Every signed-in route: forwarded when this copy keeps accounts on another
 * server, checked, and given the user and the JSON body.
 */
export async function userRoute(req: Request, options: Options, action: (user: User, body: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (options.write && !sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  if (options.throttle && !throttle(req)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Sign in first.", code: "signed_out" }, { status: 401 });
  try {
    return await action(user, req.method === "GET" ? {} : await readBody(req));
  } catch (err) {
    return failure(err);
  }
}
