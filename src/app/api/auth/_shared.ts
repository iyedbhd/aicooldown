import { NextResponse } from "next/server";
import { AuthError, createSession, sameOrigin, sessionCookie, throttle, validateCredentials, type User } from "@/lib/server/auth";
import { readBody } from "../_lib";

/** Shared body for register and login: validate, run the action, set the cookie. */
export async function credentialRoute(req: Request, action: (email: string, password: string) => Promise<User>) {
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
