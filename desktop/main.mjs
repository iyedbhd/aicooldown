/**
 * The AI Cooldown desktop app: Electron's main process. It runs the dashboard's
 * server on this computer only, with the "This machine" features on, and shows
 * the dashboard in the app's own window. Closing the window leaves the app in
 * the tray (in the Dock on macOS), where the dashboard keeps polling: scheduled
 * hellos and limit notifications keep working, and the tray icon shows the
 * next reset and whether each provider has room. Installed, it opens at login,
 * straight to the tray, and keeps itself up to date from the GitHub releases.
 *
 * On Windows the page draws its own title bar (components/TitleBar.tsx) next to
 * the system's caption buttons; the window remembers its size and place,
 * shows at once while the server starts, has native context menus, keyboard
 * shortcuts, a jump list and a taskbar badge, and a global shortcut if one is
 * set in Settings.
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
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, Tray } from "electron";
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
/** The caption buttons over the page's title bar: its background (--bg) and glyphs (--fg-2). */
const OVERLAY = { dark: { color: "#0b0c0f", symbolColor: "#d4d4d8" }, light: { color: "#f4f5f8", symbolColor: "#2a2f3a" } };
/** Where main.mjs sits, with preload.cjs and the icons. */
const HERE = import.meta.dirname;
/** How it is started at login: the dashboard loads and polls, but only the tray icon shows. */
const HIDDEN = "--hidden";
/** The page draws the title bar on Windows; macOS and Linux keep the system's. */
const TITLE_BAR_HEIGHT = process.platform === "win32" ? 40 : 0;
const MIN_SIZE = { width: 480, height: 500 };
/** Commands the page carries out (src/lib/desktop.ts), from the jump list, the tray, a second start or the macOS menu. */
const COMMANDS = new Set(["refresh", "add-account", "settings", "team", "dashboard", "toggle-notify", "palette", "copy-status"]);
/** Chrome's zoom steps, within reason. */
const ZOOM = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// Windows and Linux have no menu bar: the page and before-input-event handle the keys. Before ready, so Electron makes no default menu.
if (process.platform !== "darwin") Menu.setApplicationMenu(null);

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
let settings = null;

function readSettings() {
  if (!settings) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    } catch {
      settings = {};
    }
  }
  return settings;
}

/** Written whole to a temporary file, then renamed over the old one, so a crash mid-write cannot leave half a file. */
function writeSettings(changes) {
  settings = { ...readSettings(), ...changes };
  const file = settingsFile();
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(settings));
  }
}

/** The theme the page showed last, for the window's first paint before the page says. */
const lastTheme = () => readSettings().theme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");

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
  pushInfo();
}

/** A global accelerator such as "Ctrl+Alt+A": modifiers, then one key. */
const ACCELERATOR = /^(?:(?:Ctrl|Control|Alt|Shift|Super|Command|CommandOrControl|Option)\+){1,4}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|[`\-=[\];',./])$/;

/** Registers the shortcut that shows or hides the window from anywhere; puts the old one back if the new one is taken. */
function applyShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return { ok: true };
  const register = (keys) => {
    try {
      return globalShortcut.register(keys, toggleWindow);
    } catch {
      return false;
    }
  };
  if (!ACCELERATOR.test(accelerator)) return { ok: false, error: "That is not a shortcut AI Cooldown can use: press Ctrl or Alt with a letter, digit or F-key." };
  if (register(accelerator)) return { ok: true };
  const previous = readSettings().shortcut;
  if (previous && previous !== accelerator) register(previous);
  return { ok: false, error: `${accelerator} is taken by another app. Try another one.` };
}

// ---- Window, tray, menus and notifications.

let win = null;
let tray = null;
let started = false;
let quitting = false;
let toldAboutTray = false;
/** The window was started hidden but should come up maximized when first shown. */
let pendingMaximize = false;
/** The page listens for commands (it said so over "app:ready"); until then they wait here. */
let pageReady = false;
const queued = [];
/** When the window last lost focus or came up, for telling a tray click apart from one that should hide it. */
let lastBlur = 0;
let lastShow = 0;

/** Only web pages, in the user's browser: the window itself only ever shows the dashboard. */
function openInBrowser(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

const onDashboard = () => Boolean(win && !win.isDestroyed() && URL.canParse(win.webContents.getURL()) && new URL(win.webContents.getURL()).origin === ADDRESS);

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page of the app's own, shown while the server starts or when the dashboard cannot load. Base64, since a # in the CSS would end a plain data: URL. */
function inlinePage(body) {
  const theme = lastTheme();
  const logo = nativeImage.createFromPath(path.join(HERE, "icon.png")).resize({ width: 88, height: 88, quality: "best" }).toDataURL();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>AI Cooldown</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:${BACKGROUND[theme]};color:${theme === "dark" ? "#d4d4d8" : "#2a2f3a"};font:14px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;user-select:none;text-align:center}
.bar{position:fixed;inset:0 0 auto;height:env(titlebar-area-height,0px);-webkit-app-region:drag;app-region:drag}
img{width:88px;height:88px;animation:p 1.8s ease-in-out infinite}@keyframes p{50%{opacity:.55;transform:scale(.97)}}
p{margin:18px 0 0;opacity:.8}a{color:inherit;font-weight:600}@media (prefers-reduced-motion:reduce){img{animation:none}}</style></head>
<body><div class="bar"></div><div><img src="${logo}" alt="">${body}</div></body></html>`;
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`;
}

function showError(why) {
  if (!win || win.isDestroyed()) return;
  void win.loadURL(inlinePage(`<p>${escapeHtml(why)}</p><p><a href="${ADDRESS}/">Try again</a></p>`));
}

/** The size and place it had, if that is still on a screen; else a size that fits the screen it opens on. */
function windowBounds() {
  const saved = readSettings().window;
  const onScreen = (b) =>
    screen.getAllDisplays().some(({ workArea: a }) => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 120 && Math.min(b.y + 32, a.y + a.height) - Math.max(b.y, a.y) >= 24);
  if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && onScreen(saved)) {
    return { x: saved.x, y: saved.y, width: Math.max(MIN_SIZE.width, saved.width), height: Math.max(MIN_SIZE.height, saved.height) };
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.min(1280, Math.round(area.width * 0.9)), height: Math.min(860, Math.round(area.height * 0.9)) };
}

function createWindow(visible) {
  const theme = lastTheme();
  let maximized = Boolean(readSettings().window?.maximized);
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: "AI Cooldown",
    // Windows and macOS take the icon from the app itself.
    icon: process.platform === "linux" ? path.join(HERE, "icon.png") : undefined,
    backgroundColor: BACKGROUND[theme],
    show: false,
    ...(TITLE_BAR_HEIGHT ? { titleBarStyle: "hidden", titleBarOverlay: { ...OVERLAY[theme], height: TITLE_BAR_HEIGHT } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      // The dashboard polls and notifies from the tray too: no slowing its timers down while the window is hidden.
      backgroundThrottling: false,
      // Most fields here take tokens, codes and addresses, which a spellchecker only underlines.
      spellcheck: false,
      additionalArguments: [`--aicooldown-titlebar=${TITLE_BAR_HEIGHT}`],
    },
  });

  // Up as it was: maximized, or at its size. maximize() also shows the window, so a hidden one waits for showWindow().
  const reveal = () => (maximized ? win.maximize() : win.show());
  if (visible) {
    win.once("ready-to-show", reveal);
    setTimeout(() => win && !win.isDestroyed() && !win.isVisible() && reveal(), 3000);
  } else pendingMaximize = maximized;

  let saveTimer = null;
  const saveState = () => {
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    writeSettings({ window: { ...win.getNormalBounds(), maximized } });
  };
  const saveLater = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  win.on("maximize", () => {
    maximized = true;
    saveLater();
  });
  win.on("unmaximize", () => {
    maximized = false;
    saveLater();
  });
  win.on("resize", saveLater);
  win.on("move", saveLater);
  win.on("enter-full-screen", pushInfo);
  win.on("leave-full-screen", pushInfo);
  win.on("blur", () => (lastBlur = Date.now()));
  win.on("show", () => {
    lastShow = Date.now();
    // A hidden window has no taskbar button, and loses its badge.
    applyOverlay();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (URL.canParse(url) && new URL(url).origin === ADDRESS) return;
    event.preventDefault();
    openInBrowser(url);
  });
  win.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) pageReady = false;
  });
  win.webContents.on("did-finish-load", () => {
    if (!onDashboard()) return;
    win.webContents.setZoomFactor(readSettings().zoom ?? 1);
    pushInfo();
  });
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a navigation cut short by another, which is not a failure.
    if (isMainFrame && code !== -3 && url.startsWith(ADDRESS)) showError(`The dashboard did not load: ${description}.`);
  });
  let crashes = [];
  win.webContents.on("render-process-gone", (_event, { reason }) => {
    if (reason === "clean-exit") return;
    // A tray app has to keep polling: load it again, unless it keeps falling over.
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length <= 3) void win.loadURL(ADDRESS);
    else showError(`The dashboard stopped (${reason}).`);
  });
  win.webContents.on("context-menu", (_event, params) => showContextMenu(params));
  win.webContents.on("before-input-event", (event, input) => {
    const action = keyAction(input);
    if (!action) return;
    event.preventDefault();
    action();
  });
  // Ctrl and the mouse wheel: Chromium asks, Electron leaves it to the app.
  win.webContents.on("zoom-changed", (_event, direction) => zoom(direction === "in" ? 1 : -1));

  // Windows shutting down or signing out: let the window close, or the app would hold that up.
  win.on("session-end", () => {
    quitting = true;
  });
  win.on("close", (event) => {
    saveState();
    if (quitting) return;
    // Closing quits when Settings says so; with no window left, Electron quits (there is no window-all-closed handler).
    if (readSettings().closeToTray === false && process.platform !== "darwin") return;
    event.preventDefault();
    win.hide();
    // Out of sight is the moment to restart into a downloaded update.
    if (update.state === "ready") return installUpdate();
    if (tray && !toldAboutTray && process.platform === "win32") {
      toldAboutTray = true;
      tray.displayBalloon({ title: "AI Cooldown is still running", content: "Scheduled hellos and notifications keep going. Quit from this icon's menu.", iconType: "info" });
    }
  });
  void win.loadURL(started ? ADDRESS : inlinePage("<p>Starting AI Cooldown…</p>"));
}

function showWindow() {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) return createWindow(true);
  if (pendingMaximize) {
    pendingMaximize = false;
    win.maximize();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The tray icon and the global shortcut: up if it is not in front, away if it is. */
function toggleWindow() {
  // Clicking the tray icon takes focus from the window just before the click arrives.
  const inFront = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && (win.isFocused() || Date.now() - lastBlur < 300);
  if (!inFront) return showWindow();
  // The second click of a double-click, just after the first brought it up.
  if (Date.now() - lastShow < 600) return;
  win.hide();
}

/** Right-click: what a text field, a selection, a link or an image offers. The page's own menus (an account card's) come first. */
function showContextMenu(params) {
  const items = [];
  const link = /^https?:\/\//i.test(params.linkURL) ? params.linkURL : null;
  if (link) items.push({ label: "Open link in browser", click: () => openInBrowser(link) }, { label: "Copy link address", click: () => clipboard.writeText(link) });
  if (params.mediaType === "image" && params.hasImageContents) items.push({ label: "Copy image", click: () => win.webContents.copyImageAt(params.x, params.y) });
  const flags = params.editFlags;
  if (params.isEditable) {
    if (items.length) items.push({ type: "separator" });
    items.push(
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    if (items.length) items.push({ type: "separator" });
    items.push({ role: "copy" });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

/** The window's own keys on Windows and Linux; app commands (Ctrl+R, Ctrl+N, Ctrl+K...) are the page's. */
function keyAction(input) {
  if (input.type !== "keyDown" || process.platform === "darwin") return null;
  const key = input.key.toLowerCase();
  const ctrl = input.control && !input.alt && !input.meta;
  if (input.key === "F11" && !input.control && !input.alt) return () => win.setFullScreen(!win.isFullScreen());
  if (ctrl && !input.shift && key === "w") return () => !input.isAutoRepeat && win.close();
  if (ctrl && !input.shift && key === "q") return () => app.quit();
  if (ctrl && input.shift && key === "r") return () => (onDashboard() ? win.webContents.reloadIgnoringCache() : started && win.loadURL(ADDRESS));
  if (ctrl && (key === "=" || key === "+" || input.code === "NumpadAdd")) return () => zoom(1);
  if (ctrl && !input.shift && (key === "-" || input.code === "NumpadSubtract")) return () => zoom(-1);
  if (ctrl && !input.shift && (key === "0" || input.code === "Numpad0")) return () => zoom(0);
  // On the splash or an error page, where the page's own keys are not there.
  if (!onDashboard() && started && (input.key === "F5" || (ctrl && !input.shift && key === "r"))) return () => win.loadURL(ADDRESS);
  return null;
}

/** One zoom step in or out, or back to 100% (0); remembered. */
function zoom(direction) {
  if (!win || !onDashboard()) return;
  const current = win.webContents.getZoomFactor();
  const next = direction === 0 ? 1 : direction > 0 ? (ZOOM.find((z) => z > current + 0.001) ?? ZOOM.at(-1)) : ([...ZOOM].reverse().find((z) => z < current - 0.001) ?? ZOOM[0]);
  win.webContents.setZoomFactor(next);
  writeSettings({ zoom: next });
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

// ---- The page's side: only the dashboard's own top frame, never the splash, an error page or anything it embeds.

function fromDashboard(event) {
  const frame = event.senderFrame;
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && frame && !frame.parent && URL.canParse(frame.url) && new URL(frame.url).origin === ADDRESS);
}
const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => (fromDashboard(event) ? fn(...args) : null));
const listen = (channel, fn) =>
  ipcMain.on(channel, (event, ...args) => {
    if (fromDashboard(event)) fn(...args);
  });

// The dashboard's own notifications.
listen("notify", (title, body, tag) => notify(String(title).slice(0, 120), String(body).slice(0, 300), showWindow, `page:${String(tag).slice(0, 200)}`));

function info() {
  const s = readSettings();
  return {
    version: app.getVersion(),
    platform: process.platform,
    installed: installed(),
    dataFolder: appHome(),
    settings: { openAtLogin: openAtLogin(), closeToTray: s.closeToTray !== false, shortcut: s.shortcut ?? null },
    update: { ...update },
    fullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()),
  };
}

function pushInfo() {
  if (onDashboard()) win.webContents.send("app:info", info());
}

handle("app:info", info);

handle("app:set", (key, value) => {
  if (key === "openAtLogin" && typeof value === "boolean") {
    if (!installed()) return { ok: false, error: "Only an installed copy can open at login." };
    setOpenAtLogin(value);
    return { ok: true };
  }
  if (key === "closeToTray" && typeof value === "boolean") writeSettings({ closeToTray: value });
  else if (key === "shortcut" && (value === null || (typeof value === "string" && value.length <= 60))) {
    const result = applyShortcut(value);
    if (!result.ok) return result;
    writeSettings({ shortcut: value });
  } else return { ok: false, error: "Unknown setting." };
  pushInfo();
  return { ok: true };
});

const ACTIONS = {
  "check-updates": () => checkForUpdates(true),
  "install-update": () => (update.state === "ready" ? installUpdate() : update.state === "available" ? openInBrowser(`${RELEASES}/latest`) : undefined),
  "open-data-folder": () => shell.openPath(appHome()),
  quit: () => app.quit(),
};
handle("app:action", (name) => (Object.hasOwn(ACTIONS, name) ? ACTIONS[name]() : null));

listen("app:ready", () => {
  pageReady = true;
  for (const command of queued.splice(0)) win.webContents.send("app:command", command);
});

/** A command for the page, now or once it listens. */
function sendCommand(command) {
  if (!COMMANDS.has(command)) return;
  if (pageReady && onDashboard()) return win.webContents.send("app:command", command);
  if (!queued.includes(command)) queued.push(command);
}

listen("app:theme", (theme, explicit) => {
  if (theme !== "dark" && theme !== "light") return;
  // "system" keeps the page's prefers-color-scheme following the system.
  nativeTheme.themeSource = explicit ? theme : "system";
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(BACKGROUND[theme]);
    if (TITLE_BAR_HEIGHT) win.setTitleBarOverlay({ ...OVERLAY[theme], height: TITLE_BAR_HEIGHT });
  }
  if (readSettings().theme !== theme || readSettings().themeSource !== nativeTheme.themeSource) writeSettings({ theme, themeSource: nativeTheme.themeSource });
});

// ---- Status in the tray and on the taskbar: a dot on the icon, a line per provider in the tooltip and menu.

const LEVELS = ["none", "unknown", "go", "tight", "wait"];
/** emerald-500, amber-500 and rose-500, as the dashboard's Go / Go carefully / Wait. */
const DOT = { go: [16, 185, 129], tight: [245, 158, 11], wait: [244, 63, 94] };
let status = { level: "none", lines: [], tooltip: "AI Cooldown", notify: false };
const iconCache = new Map();

/** The mark at `size` px as the .ico draws it (hand-tuned below 64px), premultiplied BGRA, top-down; null for a size it lacks. */
function icoPixels(size) {
  const ico = fs.readFileSync(path.join(HERE, "icon.ico"));
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i;
    if ((ico[entry] || 256) !== size) continue;
    const at = ico.readUInt32LE(entry + 12);
    if (ico.readUInt32LE(at) !== 40) return null; // a PNG, from 64px
    const rows = at + 40;
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) ico.copy(out, y * size * 4, rows + (size - 1 - y) * size * 4, rows + (size - y) * size * 4);
    for (let p = 0; p < out.length; p += 4) for (let c = 0; c < 3; c++) out[p + c] = Math.round((out[p + c] * out[p + 3]) / 255);
    return out;
  }
  return null;
}

/** The app icon with a status dot in its bottom-right corner, cut out by a thin ring; or, `bare`, the dot alone for the taskbar. */
function statusIcon(level, size, bare = false) {
  const base = icoPixels(size) ?? nativeImage.createFromPath(path.join(HERE, "icon.png")).resize({ width: size, height: size, quality: "best" }).toBitmap();
  const rgb = DOT[level];
  if (!rgb) return nativeImage.createFromBitmap(base, { width: size, height: size });
  const px = bare ? Buffer.alloc(size * size * 4) : Buffer.from(base);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const paint = (radius, gap, center, [r, g, b]) => {
    const src = [b, g, r, 255];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        const cut = clamp(radius + gap + 0.5 - d);
        if (!cut) continue;
        const dot = clamp(radius + 0.5 - d);
        const i = (y * size + x) * 4;
        for (let n = 0; n < 4; n++) px[i + n] = Math.round(src[n] * dot + px[i + n] * (1 - cut) * (1 - dot));
      }
    }
  };
  if (bare) {
    // A light rim keeps it visible on a dark taskbar.
    paint(size / 2 - 0.5, 0, size / 2, [255, 255, 255]);
    paint(size / 2 - 0.5 - Math.max(1, size / 16), 0, size / 2, rgb);
  } else {
    const radius = size * 0.22;
    paint(radius, Math.max(1, size / 16), size - radius, rgb);
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

/** Windows draws tray and overlay icons from one bitmap at its own size: 16px at 100%, 24 at 150%... */
const iconSize = () => (process.platform === "win32" ? Math.round(16 * screen.getPrimaryDisplay().scaleFactor) : 32);

function cachedIcon(level, bare) {
  const size = iconSize();
  const key = `${level}:${size}:${bare}`;
  if (!iconCache.has(key)) iconCache.set(key, statusIcon(level, size, bare));
  return iconCache.get(key);
}

function trayImage() {
  if (DOT[status.level] || process.platform !== "win32") return cachedIcon(status.level, false);
  // Windows picks the right size from the .ico itself.
  return path.join(HERE, "icon.ico");
}

function applyOverlay() {
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  if (status.level === "wait") win.setOverlayIcon(cachedIcon("wait", true), status.lines.find((l) => l.includes("Wait")) ?? "Waiting for a limit to reset");
  else win.setOverlayIcon(null, "");
}

function setStatus(next) {
  const level = LEVELS.includes(next?.level) ? next.level : "none";
  const lines = Array.isArray(next?.lines) ? next.lines.filter((l) => typeof l === "string").slice(0, 4).map((l) => l.slice(0, 80)) : [];
  const tooltip = typeof next?.tooltip === "string" && next.tooltip ? next.tooltip.slice(0, 127) : "AI Cooldown";
  const notifyOn = next?.notify === true;
  const newLevel = level !== status.level;
  const newMenu = newLevel || notifyOn !== status.notify || lines.join("\n") !== status.lines.join("\n");
  status = { level, lines, tooltip, notify: notifyOn };
  tray?.setToolTip(tooltip);
  if (newLevel) {
    tray?.setImage(trayImage());
    applyOverlay();
  }
  if (newMenu) setTrayMenu();
}

listen("app:status", setStatus);

const openAtLoginItem = (label) => ({ label, type: "checkbox", checked: openAtLogin(), click: (item) => setOpenAtLogin(item.checked) });

/** Items both menus show: whether it opens at login and where an update stands. */
function appItems() {
  const login = installed() ? [openAtLoginItem(process.platform === "darwin" ? "Open at Login" : "Open at login")] : [];
  const updates = installed() ? [{ label: `Version ${app.getVersion()}`, enabled: false }, updateItem()] : [];
  return [...login, ...updates];
}

/** The tray's menu: each provider's verdict, then what to do. Rebuilt when those change, never on a timer. */
function setTrayMenu() {
  if (!tray) return;
  const showing = (command) => () => {
    showWindow();
    sendCommand(command);
  };
  const extras = appItems();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(status.lines.length ? [...status.lines.map((line) => ({ label: line, enabled: false })), { type: "separator" }] : []),
      { label: "Open AI Cooldown", click: showWindow },
      { label: "Refresh now", click: () => sendCommand("refresh") },
      { label: "Add account…", click: showing("add-account") },
      { label: "Notifications", type: "checkbox", checked: status.notify, click: () => sendCommand("toggle-notify") },
      { type: "separator" },
      ...extras,
      { label: "Settings…", click: showing("settings") },
      { type: "separator" },
      { label: "Quit AI Cooldown", click: () => app.quit() },
    ]),
  );
}

/** The macOS menu bar (Windows and Linux have none) and the tray's menu. */
function setMenus() {
  if (process.platform === "darwin") {
    const extras = appItems();
    const command = (label, accelerator, name) => ({ label, accelerator, click: () => sendCommand(name) });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            command("Settings…", "Cmd+,", "settings"),
            ...(extras.length ? [...extras, { type: "separator" }] : []),
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { label: "File", submenu: [command("Add Account…", "Cmd+N", "add-account"), command("Copy Status", "Cmd+Shift+C", "copy-status"), { type: "separator" }, { role: "close" }] },
        // The Edit menu is what makes copy and paste work on macOS.
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            command("Refresh", "Cmd+R", "refresh"),
            command("Search and Commands…", "Cmd+K", "palette"),
            { type: "separator" },
            command("Dashboard", "Cmd+1", "dashboard"),
            command("Team", "Cmd+2", "team"),
            { type: "separator" },
            { label: "Reload Window", accelerator: "Cmd+Shift+R", click: () => win?.webContents.reloadIgnoringCache() },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
  }
  setTrayMenu();
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip(status.tooltip);
  tray.on("click", toggleWindow);
  // A new screen scale needs a new bitmap.
  screen.on("display-metrics-changed", () => {
    iconCache.clear();
    tray?.setImage(trayImage());
    applyOverlay();
  });
}

/** Windows' jump list: the icon's right-click menu on the taskbar and in Start. Each task starts the app again with a command. */
function setJumpList() {
  if (process.platform !== "win32") return;
  // Only an installed copy: a build folder moves, and the list would point at nothing.
  if (!installed()) return app.setUserTasks([]);
  const task = (command, title, description) => ({ program: process.execPath, arguments: `--command=${command}`, iconPath: process.execPath, iconIndex: 0, title, description });
  app.setUserTasks([
    task("refresh", "Refresh now", "Read every account's limits again"),
    task("add-account", "Add account", "Link a Claude or ChatGPT/Codex account"),
    task("team", "Team", "Your team's people, computers and sessions"),
    task("settings", "Settings", "Notifications, startup, the shortcut and more"),
  ]);
}

// ---- Codex sign-in. Its redirect is fixed at http://localhost:1455/auth/callback, where `codex login` itself listens: while the
// Add account dialog waits, the app answers there and hands the address to the dialog, which checks it and finishes the sign-in.

const CODEX_PORT = 1455;
const CODEX_WAIT_MS = 5 * 60_000;
const CODEX_DONE = `<!doctype html><meta charset="utf-8"><title>AI Cooldown</title><style>body{display:grid;place-items:center;min-height:90vh;margin:0;font:15px "Segoe UI",system-ui,sans-serif;background:#0b0c0f;color:#d4d4d8;text-align:center}b{color:#fafafa}</style><div><p><b>Signed in.</b></p><p>You can close this tab and go back to AI Cooldown.</p></div>`;
let codexWait = null;

function waitForCodex(state) {
  codexWait?.finish({ status: "cancelled" });
  if (typeof state !== "string" || !/^[\w-]{8,200}$/.test(state)) return Promise.resolve({ status: "unavailable" });
  return new Promise((resolve) => {
    const servers = [];
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
      if (codexWait?.finish === finish) codexWait = null;
      resolve(result);
    };
    codexWait = { finish };
    const timer = setTimeout(() => finish({ status: "timeout" }), CODEX_WAIT_MS);
    const answer = (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CODEX_PORT}`);
      const host = /^(localhost|127\.0\.0\.1|\[::1\]):1455$/.test(req.headers.host ?? "");
      // Only the sign-in coming back with this dialog's state: anything else, a stray request included, is left alone.
      const ours = req.method === "GET" && host && url.pathname === "/auth/callback" && url.searchParams.get("state") === state && (url.searchParams.has("code") || url.searchParams.has("error"));
      if (!ours) {
        res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      res.end(CODEX_DONE);
      showWindow();
      // Windows keeps a background app from taking focus; the taskbar button flashes instead.
      win?.flashFrame(true);
      finish({ url: `http://localhost:${CODEX_PORT}${url.pathname}${url.search}` });
    };
    const open = (host) =>
      new Promise((ok, fail) => {
        const server = http.createServer(answer);
        server.once("error", fail);
        server.listen(CODEX_PORT, host, () => {
          servers.push(server);
          ok();
        });
      });
    // IPv4 first; then IPv6 where there is one. If `codex login` holds either, browsers could reach it instead: give way.
    open("127.0.0.1")
      .then(() =>
        open("::1").catch((err) => {
          if (err.code === "EADDRINUSE") throw err;
        }),
      )
      .catch((err) => finish({ status: err.code === "EADDRINUSE" ? "busy" : "unavailable" }));
  });
}

handle("codex:callback", waitForCodex);
listen("codex:cancel", () => codexWait?.finish({ status: "cancelled" }));

// ---- Updates. Windows and Linux download a new release in the background and install it as soon as the window is out
// of sight, restarting as they were. macOS copies cannot replace themselves without an Apple Developer ID signature, so
// they say when a new release is out and open its page.

/** idle, checking, downloading, ready (downloaded, Windows and Linux) or available (macOS), with the version concerned, when it last checked and how that went. */
let update = { state: "idle" };
/** Only a check the user asked for reports "up to date" and errors. */
let checkAsked = false;

function setUpdate(next) {
  update = next;
  setMenus();
  pushInfo();
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
  if (!installed() || (update.state !== "idle" && update.state !== "available")) return;
  checkAsked = asked;
  if (process.platform !== "darwin") {
    // Errors arrive as the "error" event too.
    return electronUpdater.autoUpdater.checkForUpdates().catch(() => undefined);
  }
  setUpdate({ ...update, state: "checking" });
  try {
    // The latest release's page, whose address ends in its tag: no GitHub API, no rate limit.
    const res = await fetch(`${RELEASES}/latest`, { redirect: "manual" });
    const version = /\/tag\/v?(\d+\.\d+\.\d+)$/.exec(res.headers.get("location") ?? "")?.[1];
    if (!version) throw new Error(`GitHub answered ${res.status}.`);
    if (!newer(version, app.getVersion())) {
      setUpdate({ state: "idle", checkedAt: Date.now() });
      return reportCheck("AI Cooldown is up to date", `You have the latest version, ${app.getVersion()}.`);
    }
    const known = update.version === version;
    setUpdate({ state: "available", version, checkedAt: Date.now() });
    if (!known || checkAsked) notify(`AI Cooldown ${version} is out`, "Click to download it. Then drag it to Applications to replace this version.", () => openInBrowser(`${RELEASES}/latest`), "update");
    checkAsked = false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setUpdate({ state: "idle", checkedAt: Date.now(), error: message });
    reportCheck("Could not check for updates", message);
  }
}

function startUpdates() {
  if (!installed()) return;
  if (process.platform !== "darwin") {
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => setUpdate({ ...update, state: "checking" }));
    autoUpdater.on("update-not-available", () => {
      setUpdate({ state: "idle", checkedAt: Date.now() });
      reportCheck("AI Cooldown is up to date", `You have the latest version, ${app.getVersion()}.`);
    });
    autoUpdater.on("update-available", (info) => {
      checkAsked = false;
      setUpdate({ state: "downloading", version: info.version, checkedAt: Date.now() });
    });
    autoUpdater.on("update-downloaded", (info) => {
      setUpdate({ state: "ready", version: info.version, checkedAt: Date.now() });
      if (!win?.isVisible()) return installUpdate();
      notify(`AI Cooldown ${info.version} is ready`, "It installs when you close the window. Click to restart and update now.", installUpdate, "update");
    });
    autoUpdater.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      setUpdate({ state: "idle", checkedAt: Date.now(), error: message });
      reportCheck("Could not check for updates", message);
    });
  }
  setTimeout(() => void checkForUpdates(), 10_000);
  setInterval(() => void checkForUpdates(), UPDATE_CHECK_MS);
}

// ---- Start.

/** A command a jump-list task (or anything else) started the app with. */
const commandIn = (argv) => {
  const command = argv.find((arg) => arg.startsWith("--command="))?.slice("--command=".length);
  return COMMANDS.has(command) ? command : undefined;
};

if (process.platform === "win32") app.setAppUserModelId(APP_ID);
// Before the single-instance lock, which lives in this folder.
app.setPath("userData", path.join(appHome(), "window"));

// The command travels with the lock too: Windows may reorder or add to a second start's arguments.
if (!app.requestSingleInstanceLock({ command: commandIn(process.argv) })) {
  app.quit();
} else {
  // Started again (from the Start menu, a shortcut, the jump list, the Dock): bring the window back. At login, stay in the tray.
  app.on("second-instance", (_event, argv, _cwd, data) => {
    const command = COMMANDS.has(data?.command) ? data.command : commandIn(argv);
    if (argv.includes(HIDDEN) && !command) return;
    showWindow();
    if (command) sendCommand(command);
  });
  app.on("activate", showWindow); // the Dock icon on macOS
  app.on("before-quit", () => {
    quitting = true;
    codexWait?.finish({ status: "cancelled" });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app
    .whenReady()
    .then(async () => {
      nativeTheme.themeSource = readSettings().themeSource ?? "system";
      // The dashboard asks for notifications and writes "copy status" to the clipboard; nothing else.
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
        callback(permission === "notifications" || permission === "clipboard-sanitized-write"),
      );
      if (process.platform !== "darwin") createTray();
      setMenus();

      const { hiddenAfterUpdate, lastVersion } = readSettings();
      writeSettings({ hiddenAfterUpdate: false, lastVersion: app.getVersion() });
      const atLogin = process.argv.includes(HIDDEN) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
      const visible = !atLogin && !hiddenAfterUpdate;
      const first = commandIn(process.argv);
      if (first) sendCommand(first);

      // Something on screen at once: the window with its splash, painted before the server's synchronous start holds this thread.
      if (visible) {
        createWindow(true);
        await new Promise((resolve) => {
          win.once("ready-to-show", resolve);
          setTimeout(resolve, 1500);
        });
        await sleep(30);
      }
      await startServer(appHome());
      started = true;
      if (win && !win.isDestroyed()) void win.loadURL(ADDRESS);
      else createWindow(false);

      // Kept pointing at this copy, so it survives updates and moves.
      if (installed()) applyOpenAtLogin(openAtLogin());
      setJumpList();
      if (readSettings().shortcut) applyShortcut(readSettings().shortcut);
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
