/** The signed-in session. Kept apart from auth so reading it does not load the database. */
export const SESSION_COOKIE = "aic_session";

export function readCookie(req: Request, name = SESSION_COOKIE): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
