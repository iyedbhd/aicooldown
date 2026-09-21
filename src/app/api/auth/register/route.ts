import { register } from "@/lib/server/auth";
import { credentialRoute } from "../_shared";

export const runtime = "nodejs";

export function POST(req: Request) {
  return credentialRoute(req, register);
}
