/**
 * The AI Cooldown desktop app: Electron's main process. It runs the dashboard's
 * server on this computer only, with the "This machine" features on, and shows
 * the dashboard in the app's own window. Closing the window leaves the app in
 * the tray (in the Dock on macOS), where the dashboard keeps polling: scheduled
 * hellos and limit notifications keep working, and the tray icon's tooltip
 * shows the next reset. Installed, it opens at login, straight to the tray,
 * and keeps itself up to date from the GitHub releases.
 *
 * desktop/build.mjs packs it with the Next.js standalone server alongside, in
 * resources/server.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, Tray } from "electron";
import electronUpdater from "electron-updater";

/** Fixed, so the window's origin, and with it the accounts and history its storage holds, stays the same between runs. */
const PORT = Number(process.env.AICOOLDOWN_PORT) || 3477;
const ADDRESS = `http://127.0.0.1:${PORT}`;
/** Where signing in keeps accounts: aicooldown.com like the website, a server of your own, or "local" for this computer. */
const ACCOUNTS = process.env.AICOOLDOWN_ACCOUNTS_SERVER || "https://aicooldown.com";
/** The installer gives its shortcut the same id; Windows shows notifications only for an app it can name. */
const APP_ID = "com.aicooldown.app";
/** Where new versions are published; installed copies read the same from resources/app-update.yml. */
const RELEASES = "https://github.com/iyedbhd/aicooldown/releases";
const UPDATE_CHECK_MS = 6 * 3600_000;
/** --bg in globals.css, so the window never flashes white while the page loads. */
const BACKGROUND = { dark: "#0b0c0f", light: "#f4f5f8" };
/** Where main.mjs sits, with preload.cjs and the icons. */
const HERE = import.meta.dirname;
/** How it is started at login: the dashboard loads and polls, but only the tray icon shows. */
const HIDDEN = "--hidden";

/** Everything the app keeps, in one folder: `data` for the server (saved logins, schedules, its database), `window` for the window's own storage. */
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

/**
 * The key that encrypts provider tokens in the local database (APP_SECRET):
 * random per install and kept with the data, never part of the app.
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

async function startServer(home) {
  const found = await probe();
  if (found === "ours") throw new Error("An older AI Cooldown is still running in a console window. Close that window, then start AI Cooldown again.");
  if (found === "other") throw new Error(`Port ${PORT} is used by another program. Close it, or set AICOOLDOWN_PORT to a free port, then start AI Cooldown again.`);

  // Absolute, since the server changes its working directory to its own folder.
  const dataDir = path.resolve(process.env.AICOOLDOWN_DATA_DIR || path.join(home, "data"));
  fs.mkdirSync(dataDir, { recursive: true });
  // Where the single-file versions before 0.3 unpacked their copy of the server.
  fs.rmSync(path.join(home, "apps"), { recursive: true, force: true });

  // The local database, used with ACCOUNTS=local, is always the file in the data folder, whatever the environment says.
  for (const key of ["LIBSQL_URL", "LIBSQL_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) delete process.env[key];
  Object.assign(process.env, {
    AICOOLDOWN_LOCAL: "1",
    AICOOLDOWN_DATA_DIR: dataDir,
    AICOOLDOWN_ACCOUNTS_SERVER: ACCOUNTS,
    APP_SECRET: appSecret(dataDir),
    HOSTNAME: "127.0.0.1", // loopback only: nothing else on the network can reach it
    PORT: String(PORT),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  if (ACCOUNTS === "local") delete process.env.AICOOLDOWN_ACCOUNTS_SERVER;
  createRequire(import.meta.url)(path.join(process.resourcesPath, "server", "server.js"));

  for (let i = 0; (await probe()) !== "ours"; i++) {
    if (i === 120) throw new Error("The dashboard's server did not start.");
    await sleep(250);
  }
}

// ---- Settings: what the app decides rather than the dashboard, kept with the window's storage.

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

const writeSettings = (changes) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...changes }));

/** Installed the way people install it, not run from a build folder: only such a copy opens at login and updates itself. */
function installed() {
  if (process.platform === "win32") return fs.existsSync(path.join(path.dirname(process.execPath), "Uninstall AI Cooldown.exe"));
  if (process.platform === "darwin") return app.isInApplicationsFolder();
  return Boolean(process.env.APPIMAGE);
}

/** On unless turned off: the point of the tray is to be running when a limit resets. */
const openAtLogin = () => installed() && readSettings().openAtLogin !== false;

/** Registers (or removes) the app as something the system starts at login, pointing at this copy. */
function applyOpenAtLogin(on) {
  if (process.platform !== "linux") return app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
  // Electron has no login items on Linux: an XDG autostart entry for the AppImage.
  const entry = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "aicooldown.desktop");
  if (!on) return fs.rmSync(entry, { force: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=AI Cooldown\nExec="${process.env.APPIMAGE}" ${HIDDEN}\nX-GNOME-Autostart-enabled=true\n`);
}

function setOpenAtLogin(on) {
  writeSettings({ openAtLogin: on });
  applyOpenAtLogin(on);
  setMenus();
}

// ---- Window, tray, menus and notifications.

let win = null;
let tray = null;
let started = false;
let quitting = false;
let toldAboutTray = false;

/** Only web pages, in the user's browser: the window itself only ever shows the dashboard. */
function openInBrowser(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function createWindow(visible) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 400,
    minHeight: 500,
    title: "AI Cooldown",
    // Windows and macOS take the icon from the app itself.
    icon: process.platform === "linux" ? path.join(HERE, "icon.png") : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      // The dashboard polls and notifies from the tray too: no slowing its timers down while the window is hidden.
      backgroundThrottling: false,
    },
  });
  if (visible) win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === ADDRESS) return;
    event.preventDefault();
    openInBrowser(url);
  });
  // The dashboard's title counts down to the next reset; the tray icon's tooltip shows it too.
  win.on("page-title-updated", (_event, title) => tray?.setToolTip(title));
  // Windows shutting down or signing out: let the window close, or the app would hold that up.
  win.on("session-end", () => {
    quitting = true;
  });
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    // Out of sight is the moment to restart into a downloaded update.
    if (update.state === "ready") return installUpdate();
    if (tray && !toldAboutTray && process.platform === "win32") {
      toldAboutTray = true;
      tray.displayBalloon({ title: "AI Cooldown is still running", content: "Scheduled hellos and notifications keep going. Quit from this icon's menu.", iconType: "info" });
    }
  });
  void win.loadURL(ADDRESS);
}

function showWindow() {
  if (!started) return;
  if (!win) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** By tag, so a newer notification replaces an older one, and held so that a click still reaches us. */
const notifications = new Map();

function notify(title, body, onClick = showWindow, tag = title) {
  if (!Notification.isSupported()) return;
  notifications.get(tag)?.close();
  const notification = new Notification({ title, body, icon: nativeImage.createFromPath(path.join(HERE, "icon.png")) });
  notification.on("click", onClick);
  notification.on("close", () => notifications.get(tag) === notification && notifications.delete(tag));
  notifications.set(tag, notification);
  notification.show();
}

// The dashboard's own notifications, through preload.cjs.
ipcMain.on("notify", (event, title, body, tag) => {
  const from = event.senderFrame?.url;
  if (!from || new URL(from).origin !== ADDRESS) return;
  notify(String(title).slice(0, 120), String(body).slice(0, 300), showWindow, `page:${String(tag).slice(0, 200)}`);
});

const openAtLoginItem = (label) => ({ label, type: "checkbox", checked: openAtLogin(), click: (item) => setOpenAtLogin(item.checked) });

/** The tray's menu and the app menu; they show whether it opens at login and where an update stands, so they are rebuilt when either changes. */
function setMenus() {
  const view = {
    label: "View",
    submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
  };
  const login = installed() ? [openAtLoginItem(process.platform === "darwin" ? "Open at Login" : "Open at login")] : [];
  const updates = installed() ? [{ label: `Version ${app.getVersion()}`, enabled: false }, updateItem()] : [];
  const extras = [...login, ...updates].length ? [...login, ...updates, { type: "separator" }] : [];
  // The Edit menu is what makes copy and paste work on macOS; the bar stays hidden on Windows and Linux until Alt.
  const appMenu =
    process.platform === "darwin"
      ? [
          { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, ...extras, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
          { role: "editMenu" },
          view,
          { role: "windowMenu" },
        ]
      : [{ label: "File", submenu: [{ role: "close" }, { label: "Quit AI Cooldown", accelerator: "Ctrl+Q", click: () => app.quit() }] }, { role: "editMenu" }, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu));
  tray?.setContextMenu(Menu.buildFromTemplate([{ label: "Open AI Cooldown", click: showWindow }, { type: "separator" }, ...extras, { label: "Quit AI Cooldown", click: () => app.quit() }]));
}

function createTray() {
  // Windows picks the right size from the .ico; elsewhere the PNG is scaled down.
  tray = new Tray(process.platform === "win32" ? path.join(HERE, "icon.ico") : nativeImage.createFromPath(path.join(HERE, "icon.png")).resize({ width: 32, height: 32 }));
  tray.setToolTip("AI Cooldown");
  tray.on("click", showWindow);
}

// ---- Updates. Windows and Linux download a new release in the background and install it as soon as the window is out
// of sight, restarting as they were. macOS copies cannot replace themselves without an Apple Developer ID signature, so
// they say when a new release is out and open its page.

/** idle, checking, downloading, ready (downloaded, Windows and Linux) or available (macOS), with the version concerned. */
let update = { state: "idle" };
/** Only a check the user asked for reports "up to date" and errors. */
let checkAsked = false;

function setUpdate(next) {
  update = next;
  setMenus();
}

function updateItem() {
  const { state, version } = update;
  if (state === "ready") return { label: `Restart to update to ${version}`, click: installUpdate };
  if (state === "available") return { label: `Download AI Cooldown ${version}…`, click: () => openInBrowser(`${RELEASES}/latest`) };
  if (state === "downloading") return { label: `Downloading ${version}…`, enabled: false };
  if (state === "checking") return { label: "Checking for updates…", enabled: false };
  return { label: "Check for updates", click: () => checkForUpdates(true) };
}

/** Quits, installs and starts again, as it was: hidden if the window was out of sight. */
function installUpdate() {
  writeSettings({ hiddenAfterUpdate: !win?.isVisible() });
  electronUpdater.autoUpdater.quitAndInstall(true, true);
}

/** Whether version a is newer than b, both x.y.z. */
function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function reportCheck(title, body) {
  if (checkAsked) notify(title, body, showWindow, "update");
  checkAsked = false;
}

async function checkForUpdates(asked = false) {
  if (update.state !== "idle" && update.state !== "available") return;
  checkAsked = asked;
  if (process.platform !== "darwin") {
    // Errors arrive as the "error" event too.
    return electronUpdater.autoUpdater.checkForUpdates().catch(() => undefined);
  }
  setUpdate({ state: "checking" });
  try {
    // The latest release's page, whose address ends in its tag: no GitHub API, no rate limit.
    const res = await fetch(`${RELEASES}/latest`, { redirect: "manual" });
    const version = /\/tag\/v?(\d+\.\d+\.\d+)$/.exec(res.headers.get("location") ?? "")?.[1];
    if (!version) throw new Error(`GitHub answered ${res.status}.`);
    if (!newer(version, app.getVersion())) {
      setUpdate({ state: "idle" });
      return reportCheck("AI Cooldown is up to date", `You have the latest version, ${app.getVersion()}.`);
    }
    const known = update.version === version;
    setUpdate({ state: "available", version });
    if (!known || checkAsked) notify(`AI Cooldown ${version} is out`, "Click to download it. Then drag it to Applications to replace this version.", () => openInBrowser(`${RELEASES}/latest`), "update");
    checkAsked = false;
  } catch (err) {
    setUpdate({ state: "idle" });
    reportCheck("Could not check for updates", err instanceof Error ? err.message : String(err));
  }
}

function startUpdates() {
  if (!installed()) return;
  if (process.platform !== "darwin") {
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => setUpdate({ state: "checking" }));
    autoUpdater.on("update-not-available", () => {
      setUpdate({ state: "idle" });
      reportCheck("AI Cooldown is up to date", `You have the latest version, ${app.getVersion()}.`);
    });
    autoUpdater.on("update-available", (info) => {
      checkAsked = false;
      setUpdate({ state: "downloading", version: info.version });
    });
    autoUpdater.on("update-downloaded", (info) => {
      setUpdate({ state: "ready", version: info.version });
      if (!win?.isVisible()) return installUpdate();
      notify(`AI Cooldown ${info.version} is ready`, "It installs when you close the window. Click to restart and update now.", installUpdate, "update");
    });
    autoUpdater.on("error", (err) => {
      setUpdate({ state: "idle" });
      reportCheck("Could not check for updates", err instanceof Error ? err.message : String(err));
    });
  }
  setTimeout(() => void checkForUpdates(), 10_000);
  setInterval(() => void checkForUpdates(), UPDATE_CHECK_MS);
}

// ---- Start.

if (process.platform === "win32") app.setAppUserModelId(APP_ID);
// Before the single-instance lock, which lives in this folder.
app.setPath("userData", path.join(appHome(), "window"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Started again (from the Start menu, a shortcut, the Dock): bring the window back. At login, stay in the tray.
  app.on("second-instance", (_event, argv) => argv.includes(HIDDEN) || showWindow());
  app.on("activate", showWindow); // the Dock icon on macOS
  app.on("before-quit", () => {
    quitting = true;
  });
  app
    .whenReady()
    .then(async () => {
      // The dashboard asks for notifications and writes "copy status" to the clipboard; nothing else.
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
        callback(permission === "notifications" || permission === "clipboard-sanitized-write"),
      );
      await startServer(appHome());
      started = true;
      if (process.platform !== "darwin") createTray();
      setMenus();
      // Kept pointing at this copy, so it survives updates and moves.
      if (installed()) applyOpenAtLogin(openAtLogin());

      const { hiddenAfterUpdate, lastVersion } = readSettings();
      writeSettings({ hiddenAfterUpdate: false, lastVersion: app.getVersion() });
      const atLogin = process.argv.includes(HIDDEN) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
      createWindow(!atLogin && !hiddenAfterUpdate);
      if (lastVersion && lastVersion !== app.getVersion()) {
        notify(`AI Cooldown updated to ${app.getVersion()}`, "Click to see what changed.", () => openInBrowser(`${RELEASES}/tag/v${app.getVersion()}`), "update");
      }
      startUpdates();
    })
    .catch((err) => {
      dialog.showErrorBox("AI Cooldown could not start", err instanceof Error ? err.message : String(err));
      app.exit(1);
    });
}
