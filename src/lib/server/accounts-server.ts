import { NextResponse } from "next/server";
import { readCookie, SESSION_COOKIE } from "./cookies";
import { isLoopback, localEnabled, localRequestAllowed } from "./local/gate";

/**
 * A copy running on the user's computer can keep AI Cooldown accounts on
 * another server instead of its own database: AICOOLDOWN_ACCOUNTS_SERVER,
 * which the desktop app points at aicooldown.com. Sign-in, linked accounts and
 * their usage are forwarded there, so the same account works on the website
 * and here. Guest accounts and the local features stay on this computer.
 */

/** The accounts server's session, renamed: localhost shares cookies across ports, so it must not meet another local copy's. */
const FORWARDED_COOKIE = "aic_remote_session";
const TIMEOUT_MS = 20_000;

/** The accounts server's origin, or null when this copy keeps accounts itself. Throws on a bad setting. */
function serverOrigin(): string | null {
  const value = process.env.AICOOLDOWN_ACCOUNTS_SERVER;
  // Only a copy on the user's own machine forwards; a public server never relays for others.
  if (!value || !localEnabled()) return null;
  const url = URL.canParse(value) ? new URL(value) : null;
  // Passwords and provider tokens travel this way: https, or plain http to this machine only.
  const safe = url && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)));
  if (!url || !safe) throw new Error("AICOOLDOWN_ACCOUNTS_SERVER must be an https:// address.");
  return url.origin;
}

/** For display: the accounts server's host, or null when this copy keeps accounts itself. */
export function accountsServerHost(): string | null {
  try {
    const origin = serverOrigin();
    return origin && new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Where signing in keeps accounts, as seen from a request to this copy, and
 * the session it is signed in with there: the accounts server, or this copy
 * itself. Throws on a bad AICOOLDOWN_ACCOUNTS_SERVER.
 */
export function accountsTarget(req: Request): { origin: string; session: string | null } {
  const origin = serverOrigin();
  return origin ? { origin, session: readCookie(req, FORWARDED_COOKIE) } : { origin: new URL(req.url).origin, session: readCookie(req) };
}

/**
 * The accounts server's answer when this copy forwards accounts, or null to
 * handle the request here. `body` is the parsed JSON when the route already
 * read it.
 */
export async function forwardAccounts(req: Request, body?: unknown): Promise<Response | null> {
  let origin: string | null;
  try {
    origin = serverOrigin();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  if (!origin) return null;
  // The accounts server cannot see the browser's origin from here, so it is checked before anything leaves.
  if (!localRequestAllowed(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });

  const { pathname, search } = new URL(req.url);
  const headers = new Headers({ accept: "application/json" });
  const type = req.headers.get("content-type");
  if (type) headers.set("content-type", type);
  // Only this app's session goes along, never the other localhost cookies in the request.
  const session = readCookie(req, FORWARDED_COOKIE);
  if (session) headers.set("cookie", `${SESSION_COOKIE}=${encodeURIComponent(session)}`);

  let res: Response;
  try {
    res = await fetch(origin + pathname + search, {
      method: req.method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : req.method === "GET" ? undefined : await req.text(),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = (err as { cause?: { code?: string } }).cause?.code ?? (err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: `Could not reach ${new URL(origin).host} (${reason}).` }, { status: 502 });
  }

  const out = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  const resType = res.headers.get("content-type");
  if (resType) out.set("content-type", resType);
  for (const cookie of res.headers.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(";");
    if (pair.slice(0, pair.indexOf("=")).trim() !== SESSION_COOKIE) continue;
    // Kept for this computer only; some browsers refuse Secure cookies over http://localhost.
    const kept = attributes.filter((a) => !/^\s*(domain|secure)\b/i.test(a));
    out.append("set-cookie", [`${FORWARDED_COOKIE}${pair.slice(pair.indexOf("="))}`, ...kept].join(";"));
  }
  return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
}
