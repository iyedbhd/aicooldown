/** Where the theme choice is kept: "light" or "dark", nothing for "follow the system". */
export const THEME_KEY = "aic:theme";

/*
 * Runs in <head> before the page paints (app/layout.tsx), so it never flashes
 * the wrong theme or the wrong chrome. It marks the desktop app's window, whose
 * preload script ran first: data-shell="desktop", and data-titlebar="custom"
 * where the page draws the title bar (Windows). CSS uses both to hide the
 * website's own chrome there.
 */
export const THEME_INIT = `(function(){var d=document.documentElement;try{var b=window.aicooldownDesktop;if(b){d.dataset.shell="desktop";d.dataset.platform=b.platform;if(b.titleBarHeight>0)d.dataset.titlebar="custom"}}catch(e){}try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}d.dataset.theme=t}catch(e){}})();`;
