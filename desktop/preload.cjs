/**
 * What the app's window adds to the dashboard, as window.aicooldownDesktop
 * (typed in src/lib/desktop.ts): native notifications, the title bar the page
 * draws on Windows, settings and actions only the main process (main.mjs) can
 * carry out, the tray's status, and commands from the tray, the jump list and
 * a second start. Main answers only the dashboard's own top frame.
 *
 * Never expose process.env here: this preload's copy of it holds APP_SECRET.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a sandboxed preload script is CommonJS */
const { contextBridge, ipcRenderer } = require("electron");

/** Subscribes to a channel; returns the unsubscribe function. */
function on(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const titleBar = process.argv.find((arg) => arg.startsWith("--aicooldown-titlebar="));

contextBridge.exposeInMainWorld("aicooldownDesktop", {
  platform: process.platform,
  titleBarHeight: Number(titleBar?.split("=")[1]) || 0,
  notify: (title, body, tag) => ipcRenderer.send("notify", String(title), String(body), String(tag)),
  getInfo: () => ipcRenderer.invoke("app:info"),
  onInfo: (callback) => on("app:info", callback),
  setSetting: (key, value) => ipcRenderer.invoke("app:set", String(key), value),
  action: (name) => ipcRenderer.invoke("app:action", String(name)),
  setStatus: (status) => ipcRenderer.send("app:status", status),
  setTheme: (theme, explicit) => ipcRenderer.send("app:theme", String(theme), Boolean(explicit)),
  onCommand: (callback) => {
    const off = on("app:command", callback);
    // Main holds commands until the page listens.
    ipcRenderer.send("app:ready");
    return off;
  },
  codexCallback: (state) => ipcRenderer.invoke("codex:callback", String(state)),
  cancelCodexCallback: () => ipcRenderer.send("codex:cancel"),
});
