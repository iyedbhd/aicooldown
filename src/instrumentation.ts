/**
 * When a local server starts, before anyone opens the dashboard: re-arms
 * scheduled hellos, and a connected computer starts checking in.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { localEnabled } = await import("./lib/server/local/gate");
  if (!localEnabled()) return;
  const { startScheduler } = await import("./lib/server/local/schedule");
  const { startAgent } = await import("./lib/server/local/device");
  await startScheduler();
  startAgent();
}
