/** Re-arms scheduled hellos when a local server starts, before anyone opens the dashboard. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { localEnabled } = await import("./lib/server/local/gate");
  if (!localEnabled()) return;
  const { startScheduler } = await import("./lib/server/local/schedule");
  await startScheduler();
}
