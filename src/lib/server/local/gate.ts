/**
 * The local features read and write the CLI credential files in the home
 * directory of whoever runs the server, so they only exist when that is the
 * user: `npm run dev`, or `AICOOLDOWN_LOCAL=1` for a local production build.
 * Never on Vercel.
 */
export function localEnabled(): boolean {
  if (process.env.VERCEL) return false;
  return process.env.AICOOLDOWN_LOCAL === "1" || process.env.NODE_ENV === "development";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only loopback hosts (blocks LAN clients and DNS rebinding) and only
 * same-origin browser requests (blocks other sites posting to localhost).
 */
export function localRequestAllowed(req: Request): boolean {
  if (!localEnabled()) return false;
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.has(host.replace(/:\d+$/, ""))) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
