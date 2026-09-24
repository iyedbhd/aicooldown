/**
 * Starts the packed desktop app the way a user would and checks that its
 * server answers with the local features and that, installed, it registers to
 * open at login. Windows installs it (silently), starts it from where the
 * installer put it, then uninstalls it and checks the login entry went too.
 * macOS runs it from the disk image. Linux runs the AppImage without FUSE and
 * without Chromium's sandbox, which a CI machine's kernel refuses. For CI only:
 * it installs, and writes a login entry.
 *
 *   node desktop/smoke.mjs   (on Linux, under xvfb-run)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "dist");
const EXT = { win32: ".exe", darwin: ".dmg", linux: ".AppImage" }[process.platform];
const artifact = fs.readdirSync(DIST).find((f) => f.startsWith("aicooldown-") && f.endsWith(EXT));
if (!artifact) throw new Error(`No aicooldown-*${EXT} in dist/`);
const file = path.join(DIST, artifact);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until check() returns something truthy, or fails with `what`. */
async function waitFor(what, check, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const loginEntry = {
  win32: () => {
    try {
      return execFileSync("reg", ["query", RUN_KEY, "/v", "com.aicooldown.app"], { encoding: "utf8" });
    } catch {
      return null;
    }
  },
  linux: () => {
    const entry = path.join(os.homedir(), ".config", "autostart", "aicooldown.desktop");
    return fs.existsSync(entry) ? fs.readFileSync(entry, "utf8") : null;
  },
}[process.platform];

let command;
let args = [];
let installDir = null;
let unmount = () => {};
if (process.platform === "win32") {
  execFileSync(file, ["/S"], { stdio: "inherit" });
  const programs = path.join(process.env.LOCALAPPDATA, "Programs");
  const dir = fs.readdirSync(programs).find((d) => fs.existsSync(path.join(programs, d, "AI Cooldown.exe")));
  if (!dir) throw new Error(`The installer put no "AI Cooldown.exe" in ${programs}`);
  installDir = path.join(programs, dir);
  command = path.join(installDir, "AI Cooldown.exe");
} else if (process.platform === "darwin") {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "aicooldown-dmg-"));
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, file], { stdio: "inherit" });
  command = path.join(mount, "AI Cooldown.app", "Contents", "MacOS", "AI Cooldown");
  unmount = () => execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "inherit" });
} else {
  fs.chmodSync(file, 0o755);
  command = file;
  args = ["--appimage-extract-and-run", "--no-sandbox"];
}

console.log(`starting ${command}`);
const app = spawn(command, args, { stdio: "inherit" });
function stopApp() {
  app.kill();
  // An installer may have started a copy of its own.
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/IM", "AI Cooldown.exe", "/T", "/F"], { stdio: "ignore" });
    } catch {
      // none left
    }
  }
}

try {
  // Polled whether or not this process is the one serving: an installer may have started the app already.
  const state = await waitFor("the app's server", () =>
    fetch("http://127.0.0.1:3477/api/local").then(
      (res) => (res.ok ? res.json() : null),
      () => null,
    ),
  );
  if (!state.live || !state.profiles) throw new Error("The app's server did not answer with the local features.");
  const page = await fetch("http://127.0.0.1:3477/");
  if (!page.ok) throw new Error(`The dashboard answered ${page.status}.`);
  console.log(`${artifact}: running, dashboard and local features answer`);

  if (loginEntry) {
    const entry = await waitFor("the open-at-login entry", loginEntry, 20);
    if (!entry.includes("--hidden")) throw new Error(`The open-at-login entry does not start it hidden:\n${entry}`);
    console.log("opens at login, hidden:", entry.trim().split("\n").pop().trim());
  }
} finally {
  stopApp();
  await sleep(2000);
  unmount();
}

if (installDir) {
  execFileSync(path.join(installDir, "Uninstall AI Cooldown.exe"), ["/S", `_?=${installDir}`], { stdio: "inherit" });
  if (loginEntry()) throw new Error("Uninstalling left the open-at-login entry behind.");
  console.log("uninstalled; the open-at-login entry went with it");
}
