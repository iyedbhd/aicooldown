/**
 * Entry point of the AI Cooldown desktop executable, a Node single executable
 * application built by desktop/build.mjs. It unpacks the bundled Next.js
 * server once per version, starts it on this computer only, with the "This
 * machine" features on, and opens the dashboard in the browser.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a single executable's entry point must be CommonJS */
"use strict";

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const sea = require("node:sea");
const { gunzipSync } = require("node:zlib");

/** Fixed, so the dashboard's origin, and the accounts its browser storage holds, stay the same between runs. */
const PORT = Number(process.env.AICOOLDOWN_PORT) || 3477;
const ADDRESS = `http://localhost:${PORT}`;

/** The unpacked server (replaced by each version) and, next to it, the data that outlives versions. */
function appHome() {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "AI Cooldown");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "AI Cooldown");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "aicooldown");
}

/** What answers on the port: "ours" (an AI Cooldown server with the local features), "none", or "other". */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/local", timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 && String(res.headers["content-type"]).startsWith("application/json") ? "ours" : "other");
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (err) => resolve(err.code === "ECONNREFUSED" ? "none" : "other"));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser() {
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", '""', ADDRESS]] : [process.platform === "darwin" ? "open" : "xdg-open", [ADDRESS]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
    .on("error", () => console.log(`Open ${ADDRESS} in your browser.`))
    .unref();
}

/**
 * The key that encrypts provider tokens in the local database (APP_SECRET):
 * random per install and kept with the data, never part of the executable.
 */
function appSecret(dataDir) {
  const file = path.join(dataDir, "app-secret");
  try {
    fs.writeFileSync(file, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * Unpacks the server into apps/<id> the first time this build runs. It is
 * written to a temporary folder and renamed, so a half-written copy is never
 * used. Payload: gzip of [u32 header length][JSON [[path, size], ...]][bytes].
 */
async function unpack(appsDir, id) {
  const dir = path.join(appsDir, id);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(appsDir, { recursive: true });
  // Earlier versions, and unpacks that died midway (one younger than an hour may still be running).
  for (const name of fs.readdirSync(appsDir)) {
    const stale = path.join(appsDir, name);
    try {
      if (!name.endsWith(".tmp") || Date.now() - fs.statSync(stale).mtimeMs > 3600_000) fs.rmSync(stale, { recursive: true, force: true });
    } catch {
      // In use or already gone; try again next update.
    }
  }

  console.log("Unpacking (first start of this version)...");
  const payload = gunzipSync(sea.getAsset("app"));
  const headerEnd = 4 + payload.readUInt32LE(0);
  const tmp = `${dir}-${process.pid}.tmp`;
  let offset = headerEnd;
  for (const [name, size] of JSON.parse(payload.toString("utf8", 4, headerEnd))) {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload.subarray(offset, (offset += size)));
  }
  // Antivirus scanners briefly lock freshly written files on Windows.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, dir);
      return dir;
    } catch (err) {
      if (fs.existsSync(dir)) {
        fs.rmSync(tmp, { recursive: true, force: true }); // another start unpacked it first
        return dir;
      }
      if (attempt === 10 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) throw err;
      await sleep(attempt * 200);
    }
  }
}

async function main() {
  process.title = "AI Cooldown";
  const { version, id } = JSON.parse(sea.getAsset("meta", "utf8"));
  console.log(`AI Cooldown ${version}`);

  const found = await probe();
  if (found === "ours") {
    console.log(`Already running at ${ADDRESS}. Opening it.`);
    return openBrowser();
  }
  if (found === "other") throw new Error(`Port ${PORT} is used by another program. Set AICOOLDOWN_PORT to a free port and start again.`);

  const home = appHome();
  const dataDir = process.env.AICOOLDOWN_DATA_DIR || path.join(home, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const appDir = await unpack(path.join(home, "apps"), id);

  // Everything stays on this computer: the database is the local file, whatever the shell exports.
  for (const key of ["LIBSQL_URL", "LIBSQL_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) delete process.env[key];
  Object.assign(process.env, {
    AICOOLDOWN_LOCAL: "1",
    AICOOLDOWN_DATA_DIR: dataDir,
    APP_SECRET: appSecret(dataDir),
    HOSTNAME: "127.0.0.1", // loopback only: nothing else on the network can reach it
    PORT: String(PORT),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  createRequire(path.join(appDir, "server.js"))("./server.js");

  for (let i = 0; (await probe()) !== "ours"; i++) {
    if (i === 120) throw new Error("The server did not start.");
    await sleep(250);
  }
  console.log(`\nAI Cooldown is running at ${ADDRESS}\nKeep this window open while you use it; close it to stop.\nData: ${dataDir}\n`);
  openBrowser();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  if (!process.stdin.isTTY) process.exit(1);
  console.error("Press Enter to close.");
  process.stdin.once("data", () => process.exit(1));
});
