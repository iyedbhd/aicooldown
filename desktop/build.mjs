/**
 * Builds the AI Cooldown desktop app for the platform it runs on:
 *
 *   npm run desktop  ->  dist/aicooldown-<os>-<arch>.<exe|dmg|AppImage>
 *
 * The app is built from a fresh copy of the files git tracks, so nothing
 * gitignored (.env files, ./data, personal and editor files) can reach it,
 * and what it ships is checked for private data before it is packed and again
 * as packed. The Next.js standalone server runs inside Electron (main.mjs),
 * which shows it in the app's own window; electron-builder, pinned in
 * desktop/package.json, makes the installer, and the update info installed
 * copies read to update themselves (latest.yml, latest-linux.yml).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const OS_NAME = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform;
const TARGET = { win32: ["win", "nsis", "exe"], darwin: ["mac", "dmg", "dmg"], linux: ["linux", "AppImage", "AppImage"] }[process.platform];
const NAME = `aicooldown-${OS_NAME}-${process.arch}`;

/** What each packed folder may hold at its top level; anything else was copied in by mistake. */
const SERVER_ENTRIES = new Set(["server.js", "package.json", ".next", "node_modules", "public"]);
/** The app's own files in desktop/; electron-builder adds its production dependencies (electron-updater) and package.json. */
const APP_FILES = ["main.mjs", "preload.cjs", "icon.ico", "icon.png"];
/** Files that only ever hold local state or secrets. */
const PRIVATE_FILE = /(^|\/)(\.env[^/]*|\.git|\.vercel|cli-profiles|\.credentials\.json|local-schedules\.json|device\.json|activity-cache\.json|app-secret|[^/]+\.(db|sqlite3?|pem|key))(\/|$)/;
/**
 * Credential shapes: Anthropic keys and OAuth tokens, JWTs (Codex and Vercel tokens), GitHub tokens, and
 * private keys with key material after the header (TLS libraries carry the bare header as a constant).
 */
const CREDENTIAL =
  /sk-ant-[a-z]{3}\d{2}-[\w-]{20,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/]{40}/;

function run(command, args, cwd, env = {}) {
  // npm is a .cmd shim on Windows, which only runs through a shell.
  execFileSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: command === "npm" && process.platform === "win32" });
}

const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * The files under dir, as [path under dir, file on disk]. A link counts as a
 * copy of what it points to: on Windows, Next writes junctions into the
 * build's own node_modules, which would not exist on the user's machine.
 */
function filesUnder(dir, buildDir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      let source = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        source = fs.realpathSync.native(source);
        if (!isInside(buildDir, source)) throw new Error(`${name} links outside the build, to ${source}`);
      }
      if (fs.statSync(source).isDirectory()) walk(source, `${name}/`);
      else files.push([name, source]);
    }
  };
  walk(dir, "");
  return files.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Values from this checkout's .env files, which must never show up in the app. */
function localSecrets() {
  const secrets = [];
  for (const name of fs.readdirSync(ROOT).filter((n) => n.startsWith(".env"))) {
    for (const line of fs.readFileSync(path.join(ROOT, name), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      const value = match?.[2].replace(/^(["'])(.*)\1$/, "$2");
      if (value && value.length >= 8) secrets.push([`${match[1]} from ${name}`, value]);
    }
  }
  return secrets;
}

/** Throws if anything private is in these files; `allowed`, when given, is every top-level entry they may have. */
function checkForLeaks(files, secrets, allowed) {
  const problems = [];
  for (const [name, source] of files) {
    if (allowed && !allowed.has(name.split("/")[0])) problems.push(`${name}: not part of the app`);
    if (PRIVATE_FILE.test(name)) problems.push(`${name}: private file`);
    const text = fs.readFileSync(source).toString("latin1");
    const credential = CREDENTIAL.exec(text);
    if (credential) problems.push(`${name}: looks like it holds a credential (${credential[0].slice(0, 10)}...)`);
    for (const [key, value] of secrets) if (text.includes(value)) problems.push(`${name}: contains ${key}`);
  }
  if (problems.length) throw new Error(`Refusing to pack: private data in the app.\n  ${problems.join("\n  ")}`);
}

/** Copies the files to dir, links resolved. */
function stage(files, dir) {
  for (const [name, source] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.copyFileSync(source, path.join(dir, name));
  }
}

async function build(work) {
  const repo = path.join(work, "repo");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of tracked) {
    if (!fs.existsSync(path.join(ROOT, file))) continue; // deleted in the working tree
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(repo, file));
  }

  run("npm", ["ci", "--no-audit", "--no-fund"], repo);
  run(process.execPath, [path.join(repo, "node_modules", "next", "dist", "bin", "next"), "build"], repo, {
    AICOOLDOWN_DESKTOP: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  const standalone = path.join(repo, ".next", "standalone");
  if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("next build did not write .next/standalone/server.js");
  fs.cpSync(path.join(repo, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(repo, "public"), path.join(standalone, "public"), { recursive: true });

  // The server, shipped next to the app as resources/server, and the app's own files.
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const server = path.join(work, "server");
  const desktop = path.join(repo, "desktop");
  stage(filesUnder(standalone, work), server);
  const secrets = localSecrets();
  const serverFiles = filesUnder(server, work);
  checkForLeaks(serverFiles, secrets, SERVER_ENTRIES);
  checkForLeaks(APP_FILES.map((file) => [file, path.join(desktop, file)]), secrets);

  // electron-builder downloads the Electron release it packs; the npm package is only where its version is pinned.
  run("npm", ["ci", "--no-audit", "--no-fund"], desktop, { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" });
  const desktopRequire = createRequire(path.join(desktop, "package.json"));
  const [platform, target, ext] = TARGET;
  fs.rmSync(DIST, { recursive: true, force: true });
  await desktopRequire("electron-builder").build({
    projectDir: desktop,
    publish: "never",
    [platform]: [target],
    [process.arch]: true,
    config: {
      appId: "com.aicooldown.app",
      productName: "AI Cooldown",
      copyright: "MIT license",
      electronVersion: desktopRequire("electron/package.json").version,
      npmRebuild: false,
      directories: { output: DIST },
      files: APP_FILES,
      // What the app reports about itself, rather than desktop/package.json's packaging details; author names the company in
      // the Windows executable's details, which otherwise keep Electron's.
      extraMetadata: { name: "aicooldown", productName: "AI Cooldown", version, description: "Know when your AI limits come back", author: { name: "AI Cooldown" }, main: "main.mjs", license: "MIT" },
      // Where installed copies look for updates (resources/app-update.yml), and what latest.yml points them to. The release workflow uploads it.
      publish: { provider: "github", owner: "iyedbhd", repo: "aicooldown" },
      artifactName: `${NAME}.\${ext}`,
      // Copied in here, before signing and the installer, rather than as extraResources, which leave out a top-level node_modules.
      afterPack: async ({ appOutDir, electronPlatformName, packager }) => {
        const resources =
          electronPlatformName === "darwin" ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources") : path.join(appOutDir, "resources");
        fs.cpSync(server, path.join(resources, "server"), { recursive: true });
      },
      win: { icon: path.join(desktop, "icon.ico") },
      // installer.nsh removes the "open at login" entry on uninstall.
      nsis: { oneClick: true, perMachine: false, differentialPackage: false, include: path.join(desktop, "installer.nsh") },
      // Ad hoc: Apple Silicon runs no unsigned code, and there is no Developer ID. Hardened runtime would reject Electron's own signed frameworks then.
      mac: { icon: path.join(desktop, "icon.png"), identity: "-", hardenedRuntime: false, category: "public.app-category.developer-tools" },
      dmg: { writeUpdateInfo: false },
      linux: { icon: path.join(desktop, "icon.png"), category: "Development", executableName: "aicooldown" },
    },
  });

  // What the installer unpacks, checked the same way: the app archive and the server beside it, all of it.
  const unpacked = fs.readdirSync(DIST).find((entry) => /-unpacked$|^mac/.test(entry) && fs.statSync(path.join(DIST, entry)).isDirectory());
  const resources = unpacked && (platform === "mac" ? path.join(DIST, unpacked, "AI Cooldown.app", "Contents", "Resources") : path.join(DIST, unpacked, "resources"));
  const packedServer = resources && fs.existsSync(path.join(resources, "server")) ? filesUnder(path.join(resources, "server"), DIST) : [];
  if (packedServer.length !== serverFiles.length) throw new Error(`The packed app has ${packedServer.length} of the server's ${serverFiles.length} files.`);
  const packed = filesUnder(resources, DIST);
  checkForLeaks(packed, secrets);
  if (!fs.readFileSync(path.join(resources, "app-update.yml"), "utf8").includes("provider: github")) throw new Error("The packed app does not know where its updates come from.");

  const out = path.join(DIST, `${NAME}.${ext}`);
  // What installed copies download to update themselves, checked against the installer just made. macOS copies are only told about new releases.
  if (platform !== "mac") {
    const info = fs.readFileSync(path.join(DIST, platform === "win" ? "latest.yml" : "latest-linux.yml"), "utf8");
    const field = (key) => new RegExp(`^${key}: ['"]?([^'"
]+)`, "m").exec(info)?.[1].trim();
    const sha512 = createHash("sha512").update(fs.readFileSync(out)).digest("base64");
    if (field("version") !== version || field("path") !== path.basename(out) || field("sha512") !== sha512) throw new Error(`The update info does not describe ${path.basename(out)} ${version}:
${info}`);
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(out)).digest("hex");
  console.log(`\n${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 2 ** 20).toFixed(1)} MB  sha256 ${sha256}`);
  console.log(`${serverFiles.length} server files and ${packed.length} packed files checked against ${secrets.length} local .env values and credential patterns: nothing private.`);
}

// Canonical, like the link targets it is compared with (macOS's temp folder is behind a symlink).
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "aicooldown-desktop-")));
try {
  await build(work);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
