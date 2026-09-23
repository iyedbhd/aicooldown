import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { AuthError, createSession, getSessionUser, sameOrigin, sessionCookie, throttle, validateCredentials, type User } from "@/lib/server/auth";
import { readBody } from "../_lib";

/** Shared body for signed-in account actions: same-origin, throttled, needs a session. */
export async function accountRoute(req: Request, action: (user: User, body: Record<string, unknown>) => Promise<NextResponse>) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  if (!throttle(req)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Sign in first.", code: "signed_out" }, { status: 401 });
  try {
    return await action(user, await readBody(req));
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Shared body for register and login: validate, run the action, set the cookie. */
export async function credentialRoute(req: Request, action: (email: string, password: string) => Promise<User>) {
  const forwarded = await forwardAccounts(req);
  if (forwarded) return forwarded;
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  if (!throttle(req)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const body = await readBody(req);
  try {
    const { email, password } = validateCredentials(body.email, body.password);
    const user = await action(email, password);
    const token = await createSession(user.id);
    return NextResponse.json({ user }, { headers: { "Set-Cookie": sessionCookie(token) } });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
