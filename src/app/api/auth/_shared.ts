import { NextResponse } from "next/server";
import { forwardAccounts } from "@/lib/server/accounts-server";
import { createSession, sameOrigin, sessionCookie, throttle, validateCredentials, type User } from "@/lib/server/auth";
import { failure, userRoute } from "../_session";
import { readBody } from "../_lib";

/** Shared body for signed-in account actions: same-origin, throttled, needs a session. */
export function accountRoute(req: Request, action: (user: User, body: Record<string, unknown>) => Promise<NextResponse>) {
  return userRoute(req, { write: true, throttle: true }, action);
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
    return failure(err);
  }
}
