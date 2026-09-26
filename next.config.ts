import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop build (npm run desktop) packages the self-contained server this writes to .next/standalone.
  output: process.env.AICOOLDOWN_DESKTOP === "1" ? "standalone" : undefined,
  // Only the desktop build carries the desktop app's title bar (lib/desktop.ts: DESKTOP_BUILD).
  env: { NEXT_PUBLIC_AICOOLDOWN_DESKTOP: process.env.AICOOLDOWN_DESKTOP === "1" ? "1" : "" },
  // next dev would otherwise write AGENTS.md and CLAUDE.md into the repository when an AI coding agent runs it.
  agentRules: false,
};

export default nextConfig;
