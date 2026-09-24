/**
 * What the app's window adds to the dashboard, as window.aicooldownDesktop:
 * native notifications, shown by the main process (main.mjs) so that clicking
 * one opens the window, even from the tray.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a sandboxed preload script is CommonJS */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aicooldownDesktop", {
  notify: (title, body, tag) => ipcRenderer.send("notify", String(title), String(body), String(tag)),
});
