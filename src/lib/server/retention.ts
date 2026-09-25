import { db } from "./db";

/*
 * How long what passes through for teams is kept: remote sessions with their
 * output for 30 days, conversations read from computers and commands sent to
 * them for a week, images for three days (their computer sends them again
 * when asked); and sign-ins until they expire. Deleted as the server goes
 * about its work (the team page loading, computers checking in), at most once
 * an hour per server instance, each delete reading only what it deletes.
 */

const RUNS_KEEP_MS = 30 * 86400_000;
const TRANSCRIPTS_KEEP_MS = 7 * 86400_000;
const IMAGES_KEEP_MS = 3 * 86400_000;
const EVERY_MS = 60 * 60_000;

let last = 0;

/** Best effort: a failure waits for the next turn. */
export async function purgeExpired(): Promise<void> {
  const now = Date.now();
  if (now - last < EVERY_MS) return;
  last = now;
  await db()
    .batch(
      [
        { sql: "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE created_at < ?)", args: [now - RUNS_KEEP_MS] },
        { sql: "DELETE FROM runs WHERE created_at < ?", args: [now - RUNS_KEEP_MS] },
        { sql: "DELETE FROM session_transcripts WHERE updated_at < ?", args: [now - TRANSCRIPTS_KEEP_MS] },
        { sql: "DELETE FROM session_images WHERE updated_at < ?", args: [now - IMAGES_KEEP_MS] },
        { sql: "DELETE FROM sessions WHERE expires_at < ?", args: [now] },
        { sql: "DELETE FROM device_commands WHERE created_at < ?", args: [now - TRANSCRIPTS_KEEP_MS] },
      ],
      "write",
    )
    .catch((err: unknown) => console.error("[retention]", err));
}
