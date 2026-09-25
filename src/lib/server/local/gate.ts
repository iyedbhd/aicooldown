import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

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

/** A host name (no port) that only ever means this computer. */
export const isLoopback = (hostname: string) => LOOPBACK.has(hostname);

/** Where a request came from on the network, as the server's socket saw it. */
const PEER = "x-aicooldown-peer";

/**
 * Stamps every request this process serves with its TCP peer, over anything
 * the client sent under that name. Node publishes each request on this
 * channel before the server hands it on, so Next only ever sees the stamp.
 * Once per process: instrumentation.ts calls it at start-up.
 */
export function watchPeers(): void {
  const g = globalThis as typeof globalThis & { __aicooldownPeers?: boolean };
  if (g.__aicooldownPeers) return;
  g.__aicooldownPeers = true;
  subscribe("http.server.request.start", (message) => {
    const { request, socket } = message as { request: IncomingMessage; socket: Socket };
    request.headers[PEER] = socket.remoteAddress ?? "";
  });
}

const fromThisComputer = (address: string) => address === "::1" || /^(::ffff:)?127\./.test(address);

/**
 * Only requests from this computer: `next dev` and `next start` listen on
 * every network interface, and another computer can send any Host header,
 * so the socket decides (a request without the stamp is refused). Then only
 * loopback hosts (blocks DNS rebinding) and only same-origin browser requests
 * (blocks other sites posting to localhost).
 */
export function localRequestAllowed(req: Request): boolean {
  if (!localEnabled()) return false;
  if (!fromThisComputer(req.headers.get(PEER) ?? "")) return false;
  const host = req.headers.get("host") ?? "";
  if (!isLoopback(host.replace(/:\d+$/, ""))) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
