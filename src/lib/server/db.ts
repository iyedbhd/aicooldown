import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { DATA_DIR } from "./data-dir";

/**
 * One libSQL connection for the process. Locally this is a SQLite file in the
 * data directory; in production point LIBSQL_URL (and LIBSQL_AUTH_TOKEN) at
 * Turso or any libSQL server, since serverless filesystems do not persist.
 * `next dev` keeps to the file (see connection()).
 */
let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS linked_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  plan TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  account_id TEXT,
  owned INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS linked_accounts_user ON linked_accounts(user_id);
CREATE TABLE IF NOT EXISTS account_usage (
  account_id TEXT PRIMARY KEY REFERENCES linked_accounts(id) ON DELETE CASCADE,
  usage TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);
CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_invites_team ON team_invites(team_id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  info TEXT NOT NULL,
  activity TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hot_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, machine_id)
);
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  args TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS device_commands_device ON device_commands(device_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool TEXT NOT NULL DEFAULT 'claude',
  created_by TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  resume_session TEXT,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_device ON runs(device_id, created_at);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS session_transcripts (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  content TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, tool, session_id)
);
CREATE TABLE IF NOT EXISTS session_images (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  status TEXT NOT NULL,
  type TEXT,
  content TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, tool, session_id, n)
);
CREATE TABLE IF NOT EXISTS sharing (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  policy TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Columns added to a table after it first existed somewhere: each runs once
 * per database, and "duplicate column" means it already has.
 */
const MIGRATIONS = [
  "ALTER TABLE runs ADD COLUMN tool TEXT NOT NULL DEFAULT 'claude'",
  "ALTER TABLE devices ADD COLUMN hot_until INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN label TEXT",
];

/**
 * Where the data lives: the libSQL server in the environment (TURSO_* are what
 * Vercel's Turso integration injects, LIBSQL_* any other), or else a file in
 * the data directory. A development server stays on the file even when the
 * environment names a server, which in a .env.local is usually production:
 * trying things out would read and write real accounts. AICOOLDOWN_REMOTE_DB=1
 * lets it, on purpose.
 */
function choose(): { url: string; authToken?: string } {
  // libSQL percent-decodes file: URLs and stops at ? and #, so those are escaped in the path.
  // The ignore comment keeps a database file lying in ./data out of the build's traces.
  const file = `file:${path.join(/* turbopackIgnore: true */ DATA_DIR, "aicooldown.db").replace(/[%?#]/g, encodeURIComponent)}`;
  const url = process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL;
  if (!url) return { url: file };
  if (process.env.NODE_ENV === "development" && !url.startsWith("file:") && process.env.AICOOLDOWN_REMOTE_DB !== "1") {
    console.warn(`[db] A development server uses ${file}, not the database server in the environment. Set AICOOLDOWN_REMOTE_DB=1 to use that one.`);
    return { url: file };
  }
  return { url, authToken: process.env.LIBSQL_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined };
}

let chosen: ReturnType<typeof choose> | null = null;
const connection = () => (chosen ??= choose());

/** Whether the data lives on a database server rather than in a file on this computer. */
export const remoteDatabase = () => !connection().url.startsWith("file:");

export function db(): Client {
  client ??= createClient(connection());
  return client;
}

/** `?, ?, ?` for an IN list of `count` values; `NULL` for none, which matches nothing. */
export function placeholders(count: number): string {
  return count === 0 ? "NULL" : Array.from({ length: count }, () => "?").join(", ");
}

async function migrate(): Promise<void> {
  await db().executeMultiple(SCHEMA);
  for (const sql of MIGRATIONS) {
    await db()
      .execute(sql)
      .catch((err: unknown) => {
        if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
      });
  }
}

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}
