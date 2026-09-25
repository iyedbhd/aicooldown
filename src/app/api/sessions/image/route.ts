import { NextResponse } from "next/server";
import { getImage } from "@/lib/server/images";
import { userRoute } from "../../_session";

export const runtime = "nodejs";

/**
 * One image of a session, as its computer sent it: `?deviceId&tool&sessionId&n`.
 * Served as the picture it was checked to be, and as nothing else.
 */
export function GET(req: Request) {
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return userRoute(req, {}, async (user) => {
    const image = await getImage(user, query);
    if (!image) return NextResponse.json({ error: "That image is not here yet." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new NextResponse(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.type,
        "Content-Length": String(image.bytes.length),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
