import path from "node:path";

/**
 * Where this server keeps its own files: the local database, saved CLI logins
 * and scheduled hellos. ./data by default; the desktop app sets
 * AICOOLDOWN_DATA_DIR to the user's app-data folder.
 *
 * The ignore comment keeps the build from tracing ./data (runtime state, not a
 * build input) into every server route that imports this.
 */
export const DATA_DIR = process.env.AICOOLDOWN_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data");
