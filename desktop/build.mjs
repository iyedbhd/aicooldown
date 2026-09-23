/**
 * Builds the AI Cooldown desktop executable for the platform it runs on:
 *
 *   npm run desktop  ->  dist/aicooldown-<os>-<arch>[.exe]
 *
 * The app is built from a fresh copy of the files git tracks, so nothing
 * gitignored (.env files, ./data, personal and editor files) can reach the
 * executable, and the result is checked for private data before it is packed.
 * The standalone Next.js server is then packed into a copy of this Node binary
 * as a single executable application, started by desktop/launcher.js. On
 * Windows it also takes the app's icon (desktop/icon.ico, from npm run brand).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const OS_NAME = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform;
const OUT = path.join(ROOT, "dist", `aicooldown-${OS_NAME}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);

/** The only entries a standalone server needs; anything else beside them was copied in by mistake. */
const SERVER_ENTRIES = new Set(["server.js", "package.json", ".next", "node_modules", "public"]);
/** Files that only ever hold local state or secrets. */
const PRIVATE_FILE = /(^|\/)(\.env[^/]*|\.git|\.vercel|cli-profiles|\.credentials\.json|local-schedules\.json|app-secret|[^/]+\.(db|sqlite3?|pem|key))(\/|$)/;
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
 * The files to pack, as [path in the app, file on disk]. A link is packed as
 * a copy of what it points to: on Windows, Next writes junctions into the
 * build's own node_modules, which would not exist on the user's machine.
 */
function appFiles(app, buildDir) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      let source = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        source = fs.realpathSync.native(source);
        if (!isInside(buildDir, source)) throw new Error(`${name} links outside the build, to ${source}`);
      }
      if (fs.statSync(source).isDirectory()) walk(source, `${name}/`);
      else files.push([name, source]);
    }
  };
  walk(app, "");
  return files.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Values from this checkout's .env files, which must never show up in the build. */
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

/** Throws if anything private made it into the files about to be packed. */
function checkForLeaks(names, contents) {
  const secrets = localSecrets();
  const problems = [];
  names.forEach((name, i) => {
    if (!SERVER_ENTRIES.has(name.split("/")[0])) problems.push(`${name}: not part of the server`);
    if (PRIVATE_FILE.test(name)) problems.push(`${name}: private file`);
    const text = contents[i].toString("latin1");
    const credential = CREDENTIAL.exec(text);
    if (credential) problems.push(`${name}: looks like it holds a credential (${credential[0].slice(0, 10)}...)`);
    for (const [key, value] of secrets) if (text.includes(value)) problems.push(`${name}: contains ${key}`);
  });
  if (problems.length) throw new Error(`Refusing to pack: private data in the build.\n  ${problems.join("\n  ")}`);
  return secrets.length;
}

/**
 * Swaps node.exe's icon and name in the Windows executable for the app's, so
 * Explorer shows the AI Cooldown icon and Task Manager says "AI Cooldown"
 * rather than "Node.js JavaScript Runtime". Runs after postject: resizing the
 * resources can move the sections behind them, which postject's PE parser
 * misreads, and once the blob is in, the resources are the file's last section.
 */
async function brandWindowsExe(repoRequire, repo, version) {
  const { Data, NtExecutable, NtExecutableResource, Resource } = await import(pathToFileURL(repoRequire.resolve("resedit")).href);
  const exe = NtExecutable.from(fs.readFileSync(OUT), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const icons = Data.IconFile.from(fs.readFileSync(path.join(repo, "desktop", "icon.ico"))).icons.map((icon) => icon.data);
  for (const group of Resource.IconGroupEntry.fromEntries(res.entries)) Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons);

  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  const [major, minor, patch] = version.split(/[.-]/, 3).map(Number);
  info.setFileVersion(major, minor, patch);
  info.setProductVersion(major, minor, patch);
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.setStringValues(lang, {
      ProductName: "AI Cooldown",
      FileDescription: "AI Cooldown",
      CompanyName: "AI Cooldown",
      InternalName: "aicooldown",
      OriginalFilename: path.basename(OUT),
      FileVersion: version,
      ProductVersion: version,
      LegalCopyright: "MIT license. Includes Node.js, copyright Node.js contributors, MIT license.",
    });
  }
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(OUT, Buffer.from(exe.generate()));
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
  const app = path.join(repo, ".next", "standalone");
  if (!fs.existsSync(path.join(app, "server.js"))) throw new Error("next build did not write .next/standalone/server.js");
  fs.cpSync(path.join(repo, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(repo, "public"), path.join(app, "public"), { recursive: true });

  const files = appFiles(app, work);
  const names = files.map(([name]) => name);
  const contents = files.map(([, source]) => fs.readFileSync(source));
  const secretCount = checkForLeaks(names, contents);

  // Payload: gzip of [u32 header length][JSON [[path, size], ...]][file bytes in that order].
  const header = Buffer.from(JSON.stringify(names.map((name, i) => [name, contents[i].length])));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32LE(header.length);
  const payload = gzipSync(Buffer.concat([headerLength, header, ...contents]), { level: 9 });
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const id = `${version}-${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  fs.writeFileSync(path.join(work, "app.gz"), payload);
  fs.writeFileSync(path.join(work, "meta.json"), JSON.stringify({ version, id }));
  // Relative to work: the blob keeps the entry script's path as written here.
  fs.writeFileSync(
    path.join(work, "sea-config.json"),
    JSON.stringify({
      main: "repo/desktop/launcher.js",
      output: "sea.blob",
      disableExperimentalSEAWarning: true,
      assets: { app: "app.gz", meta: "meta.json" },
    }),
  );
  run(process.execPath, ["--experimental-sea-config", "sea-config.json"], work);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(process.execPath, OUT);
  fs.chmodSync(OUT, 0o755);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", OUT], work);
  // On Windows this drops node.exe's signature (postject warns it "seems corrupted"): the result is plainly unsigned.
  const repoRequire = createRequire(path.join(repo, "package.json"));
  const { inject } = repoRequire("postject");
  await inject(OUT, "NODE_SEA_BLOB", fs.readFileSync(path.join(work, "sea.blob")), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
  });
  if (process.platform === "win32") await brandWindowsExe(repoRequire, repo, version);
  // Apple Silicon only runs signed code; an ad-hoc signature is enough.
  if (process.platform === "darwin") run("codesign", ["--sign", "-", OUT], work);

  const sha256 = createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
  console.log(`\n${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 2 ** 20).toFixed(1)} MB  sha256 ${sha256}`);
  console.log(`${files.length} files checked against ${secretCount} local .env values and credential patterns: nothing private.`);
}

// Canonical, like the link targets it is compared with (macOS's temp folder is behind a symlink).
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "aicooldown-desktop-")));
try {
  await build(work);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
