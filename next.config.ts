import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop build (npm run desktop) packages the self-contained server this writes to .next/standalone.
  output: process.env.AICOOLDOWN_DESKTOP === "1" ? "standalone" : undefined,
};

export default nextConfig;
