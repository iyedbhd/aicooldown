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

/**
 * A RequestError as its status and message. Anything else is a 500 that says
 * nothing of the server's insides (a database error names tables and hosts):
 * those go to its log.
 */
export function failure(err: unknown): NextResponse {
  if (err instanceof RequestError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("[api]", err);
  return NextResponse.json({ error: "Something went wrong on the server. Try again in a moment." }, { status: 500 });
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
