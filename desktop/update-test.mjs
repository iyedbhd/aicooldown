/**
 * Checks that an installed copy updates itself the way users' copies will. It
 * installs the app from the installer given, points that copy at a local update
 * server offering the newer build in the folder given (its installer and
 * latest.yml), waits for it to download the update, then closes the window to
 * the tray, which is when a downloaded update installs, and waits for the newer
 * version to be installed and running again, still in the tray. Windows, for
 * CI only: it installs, then uninstalls.
 *
 *   node desktop/update-test.mjs <older installer> <folder with the newer build>
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [older, newer] = process.argv.slice(2).map((p) => path.resolve(p));
const newVersion = /^version: ['"]?([^'"\n]+)/m.exec(fs.readFileSync(path.join(newer, "latest.yml"), "utf8"))[1].trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const powershell = (command) => execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();

async function waitFor(what, check, seconds = 180) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const serverAnswers = () => fetch("http://127.0.0.1:3477/api/local").then((res) => res.ok, () => false);
const stopApp = () => {
  try {
    execFileSync("taskkill", ["/IM", "AI Cooldown.exe", "/T", "/F"], { stdio: "ignore" });
  } catch {
    // none running
  }
};

// The update server: latest.yml and the installer it names. Anything else (a blockmap) is missing, so the download is whole.
const requested = [];
const updates = http
  .createServer((req, res) => {
    const name = path.basename(new URL(req.url, "http://localhost").pathname);
    requested.push(name);
    const file = path.join(newer, name);
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  })
  .listen(8123, "127.0.0.1");

execFileSync(older, ["/S"], { stdio: "inherit" });
stopApp(); // in case the installer started it with its own update settings
const programs = path.join(process.env.LOCALAPPDATA, "Programs");
const installDir = path.join(programs, fs.readdirSync(programs).find((d) => fs.existsSync(path.join(programs, d, "AI Cooldown.exe"))));
const exe = path.join(installDir, "AI Cooldown.exe");
/** x.y.z of the installed executable (Windows says x.y.z.0), or "" while an update has it replaced. */
const installedVersion = () =>
  powershell(`(Get-Item '${exe}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`)
    .split(".")
    .slice(0, 3)
    .join(".");
const oldVersion = installedVersion();
fs.writeFileSync(path.join(installDir, "resources", "app-update.yml"), "provider: generic\nurl: http://127.0.0.1:8123\nupdaterCacheDirName: aicooldown-updater\n");

try {
  console.log(`installed ${oldVersion}; offering ${newVersion}`);
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  await waitFor("the app's server", serverAnswers);
  // Written once the download has passed its checksum.
  const downloaded = path.join(process.env.LOCALAPPDATA, "aicooldown-updater", "pending", "update-info.json");
  await waitFor("the update to download", () => fs.existsSync(downloaded));
  console.log(`downloaded; asked for ${[...new Set(requested)].join(", ")}`);
  await sleep(2000);

  powershell("(Get-Process 'AI Cooldown' | Where-Object MainWindowHandle -ne 0).CloseMainWindow()");
  let seen = oldVersion;
  await waitFor(`version ${newVersion} to be installed`, () => (seen = installedVersion() || seen) === newVersion).catch((err) => {
    throw new Error(`${err.message} Installed now: ${seen}.`);
  });
  await waitFor("the updated app's server", serverAnswers);
  await sleep(3000);
  const visible = powershell("@(Get-Process 'AI Cooldown' | Where-Object MainWindowHandle -ne 0).Count");
  if (visible !== "0") throw new Error("The updated app came back with its window showing; it was in the tray.");
  console.log(`updated ${oldVersion} -> ${installedVersion()}, running again in the tray`);
} finally {
  stopApp();
  updates.close();
  await sleep(2000);
  execFileSync(path.join(installDir, "Uninstall AI Cooldown.exe"), ["/S", `_?=${installDir}`], { stdio: "inherit" });
}
