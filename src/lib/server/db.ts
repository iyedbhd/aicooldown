import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { DATA_DIR } from "./data-dir";

/**
 * One libSQL connection for the process. Locally this is a SQLite file in the
 * data directory; in production point LIBSQL_URL (and LIBSQL_AUTH_TOKEN) at
 * Turso or any libSQL server, since serverless filesystems do not persist.
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
`;

export function db(): Client {
  if (!client) {
    // TURSO_* are what Vercel's Turso integration injects; LIBSQL_* for any other libSQL server.
    client = createClient({
      // libSQL percent-decodes file: URLs and stops at ? and #, so those are escaped in the path.
      // The ignore comment keeps a database file lying in ./data out of the build's traces.
      url: process.env.LIBSQL_URL ?? process.env.TURSO_DATABASE_URL ?? `file:${path.join(/* turbopackIgnore: true */ DATA_DIR, "aicooldown.db").replace(/[%?#]/g, encodeURIComponent)}`,
      authToken: process.env.LIBSQL_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    });
  }
  return client;
}

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db()
      .executeMultiple(SCHEMA)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}
