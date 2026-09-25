/**
 * When a local server starts, before anyone opens the dashboard: notes where
 * each request comes from (only this computer may use the local features),
 * re-arms scheduled hellos, and a connected computer starts checking in.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { localEnabled, watchPeers } = await import("./lib/server/local/gate");
  if (!localEnabled()) return;
  watchPeers();
  const { startScheduler } = await import("./lib/server/local/schedule");
  const { startAgent } = await import("./lib/server/local/device");
  await startScheduler();
  startAgent();
}
