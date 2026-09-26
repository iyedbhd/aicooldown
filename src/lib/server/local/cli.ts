import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliProfile, LiveLogin } from "@/lib/local";
import type { ToolState } from "@/lib/team";
import { claudePlanLabel, fetchClaudeAccount, fetchClaudeUsage, refreshClaudeTokens } from "@/lib/providers/claude";
import { codexIdentityFromTokens, fetchCodexUsage } from "@/lib/providers/codex";
import { DATA_DIR } from "@/lib/server/data-dir";
import { isSessionWindow } from "@/lib/stats";
import { ProviderError, type Provider } from "@/lib/types";

/**
 * Account switching the way the CLIs allow it: each saved login is a copy of
 * the CLI's own credential files under data/cli-profiles. Switching writes
 * the live files back into the outgoing login's copy (the CLI rotates refresh
 * tokens, so the live copy is the newest) and then puts the chosen copy in
 * place. A login's tokens are only ever used from one place at a time: the
 * live files while active, its own directory otherwise, where the CLI can
 * still run against it through CLAUDE_CONFIG_DIR / CODEX_HOME.
 */

const PROFILES_DIR = path.join(DATA_DIR, "cli-profiles");

/** Raw credential objects, kept verbatim so the CLI reads back exactly what it wrote. */
type Login =
  | { provider: "claude"; credentials: Record<string, unknown>; oauthAccount?: Record<string, unknown> }
  | { provider: "codex"; auth: Record<string, unknown> };

type Meta = { id: string; provider: Provider; key: string; label: string; plan?: string; savedAt: number };

/** Where a login lives: the CLI's live files, or a saved profile directory. */
type Place = { dir: string; claudeConfig: string };

/** Where the CLI keeps the login it uses now, and its session logs. */
export function livePlace(provider: Provider): Place {
  if (provider === "codex") return { dir: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), claudeConfig: "" };
  const custom = process.env.CLAUDE_CONFIG_DIR;
  return custom
    ? { dir: custom, claudeConfig: path.join(custom, ".claude.json") }
    : { dir: path.join(os.homedir(), ".claude"), claudeConfig: path.join(os.homedir(), ".claude.json") };
}

function profilePlace(provider: Provider, id: string): Place {
  const dir = path.join(PROFILES_DIR, provider, id);
  return { dir, claudeConfig: path.join(dir, ".claude.json") };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Write-then-rename so a crash never leaves a CLI with half a credentials file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function readLogin(provider: Provider, place: Place): Promise<Login | null> {
  if (provider === "codex") {
    const auth = await readJson(path.join(place.dir, "auth.json"));
    const tokens = auth?.tokens as { access_token?: unknown } | undefined;
    return auth && typeof tokens?.access_token === "string" ? { provider, auth } : null;
  }
  const credentials = await readJson(path.join(place.dir, ".credentials.json"));
  const oauth = credentials?.claudeAiOauth as { accessToken?: unknown } | undefined;
  if (!credentials || typeof oauth?.accessToken !== "string") return null;
  const config = await readJson(place.claudeConfig);
  const oauthAccount = config?.oauthAccount;
  return { provider, credentials, oauthAccount: oauthAccount && typeof oauthAccount === "object" ? (oauthAccount as Record<string, unknown>) : undefined };
}

async function writeLogin(login: Login, place: Place): Promise<void> {
  if (login.provider === "codex") return writeJson(path.join(place.dir, "auth.json"), login.auth);
  await writeJson(path.join(place.dir, ".credentials.json"), login.credentials);
  if (!login.oauthAccount) return;
  // The live ~/.claude.json holds much more (projects, settings); only the account changes.
  const config = (await readJson(place.claudeConfig)) ?? { hasCompletedOnboarding: true };
  await writeJson(place.claudeConfig, { ...config, oauthAccount: login.oauthAccount });
}

/** The token a refresh replaces: two copies of a login holding the same one are in the same state. */
function currentToken(login: Login): string {
  if (login.provider === "codex") {
    const t = login.auth.tokens as { access_token: string; refresh_token?: string };
    return t.refresh_token ?? t.access_token;
  }
  const oauth = login.credentials.claudeAiOauth as { accessToken: string; refreshToken?: string };
  return oauth.refreshToken ?? oauth.accessToken;
}

/** How Claude Code names an account in oauthAccount; saved Claude logins are keyed the same way. */
const claudeKey = (accountUuid: string, organizationUuid?: string) => `${accountUuid}:${organizationUuid ?? ""}`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const LOOKUP_RETRY_MS = 5 * 60_000;
const claudeAccounts = new Map<string, Promise<{ key: string; email?: string }>>();

/** Whose account a Claude access token is, asked of Anthropic once per token; a failed lookup is retried after a while. */
function claudeAccount(accessToken: string): Promise<{ key: string; email?: string }> {
  const id = sha256(accessToken);
  let lookup = claudeAccounts.get(id);
  if (!lookup) {
    lookup = fetchClaudeAccount(accessToken).then(({ accountUuid, organizationUuid, email }) => {
      const key = accountUuid ? claudeKey(accountUuid, organizationUuid) : email;
      if (!key) throw new Error("Anthropic did not say which account it is.");
      return { key, email };
    });
    claudeAccounts.set(id, lookup);
    lookup.catch(() => setTimeout(() => claudeAccounts.delete(id), LOOKUP_RETRY_MS).unref());
  }
  return lookup;
}

/** The saved login this one is in the same state as, if any. */
async function savedCopyOf(login: Login): Promise<Meta | undefined> {
  const token = currentToken(login);
  for (const meta of await listMeta()) {
    if (meta.provider !== login.provider) continue;
    const saved = await readLogin(meta.provider, profilePlace(meta.provider, meta.id));
    if (saved && currentToken(saved) === token) return meta;
  }
  return undefined;
}

/** A stable key for "the same account", independent of token rotation. Only ever asked about the CLI's live login. */
async function identify(login: Login): Promise<{ key: string; label: string; plan?: string }> {
  if (login.provider === "codex") {
    const t = login.auth.tokens as { access_token: string; id_token?: string; account_id?: string };
    const id = codexIdentityFromTokens(t.access_token, t.id_token);
    const email = id.email ?? "Codex login";
    return { key: `${t.account_id ?? id.accountId ?? ""}:${email}`, label: email, plan: id.plan };
  }
  // Not from oauthAccount in ~/.claude.json: every Claude Code on this machine writes its own account there,
  // the Claude desktop app's included. The token is what counts.
  const oauth = login.credentials.claudeAiOauth as { accessToken: string; subscriptionType?: string; rateLimitTier?: string };
  const plan = claudePlanLabel({ subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier });
  // A saved login the CLI has not refreshed since: known without asking, even once its access token has expired.
  const copy = await savedCopyOf(login);
  if (copy) return { key: copy.key, label: copy.label, plan };
  try {
    const account = await claudeAccount(oauth.accessToken);
    return { key: account.key, label: account.email ?? "Claude login", plan };
  } catch (err) {
    throw new Error(
      err instanceof ProviderError && err.status === 401
        ? "The Claude Code CLI's access token has expired, so which account it is can't be checked. Run claude in a terminal once to refresh it, then try again."
        : `Could not check which account the Claude Code CLI is signed in with: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The login without an oauthAccount block that names another account (the Claude desktop app writes its own there). */
function withOwnAccount(login: Login, key: string): Login {
  if (login.provider !== "claude" || !login.oauthAccount) return login;
  const { accountUuid, organizationUuid } = login.oauthAccount as { accountUuid?: string; organizationUuid?: string };
  return accountUuid && claudeKey(accountUuid, organizationUuid) === key ? login : { ...login, oauthAccount: undefined };
}

const profileId = (provider: Provider, key: string) => sha256(`${provider}:${key}`).slice(0, 12);

async function listMeta(): Promise<Meta[]> {
  const out: Meta[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const ids = await readdir(path.join(PROFILES_DIR, provider)).catch(() => [] as string[]);
    for (const id of ids) {
      const meta = (await readJson(path.join(PROFILES_DIR, provider, id, "profile.json"))) as Meta | null;
      if (meta?.id === id) out.push(meta);
    }
  }
  return out.sort((a, b) => a.savedAt - b.savedAt);
}

/** The Claude accounts saved here, as account and organization ids with their labels (emails): the Claude app's chat folders use the same ids. */
export async function savedClaudeAccounts(): Promise<{ accountUuid: string; organizationUuid: string; label: string }[]> {
  return (await listMeta())
    .filter((m) => m.provider === "claude" && m.key.includes(":"))
    .map((m) => {
      const [accountUuid, organizationUuid] = m.key.split(":");
      return { accountUuid, organizationUuid, label: m.label };
    });
}

async function getMeta(id: string): Promise<Meta> {
  const meta = (await listMeta()).find((m) => m.id === id);
  if (!meta) throw new Error("That saved login no longer exists.");
  return meta;
}

/** Saves a login under its account's profile, replacing an older copy of the same account. */
async function saveLogin(login: Login): Promise<Meta> {
  const who = await identify(login);
  const id = profileId(login.provider, who.key);
  const place = profilePlace(login.provider, id);
  const previous = (await readJson(path.join(place.dir, "profile.json"))) as Meta | null;
  await writeLogin(withOwnAccount(login, who.key), place);
  const meta: Meta = { id, provider: login.provider, key: who.key, label: who.label, plan: who.plan, savedAt: previous?.savedAt ?? Date.now() };
  await writeJson(path.join(place.dir, "profile.json"), meta);
  return meta;
}

async function liveKey(provider: Provider): Promise<string | null> {
  const login = await readLogin(provider, livePlace(provider));
  return login ? (await identify(login).catch(() => null))?.key ?? null : null;
}

export async function liveState(): Promise<{ live: Record<Provider, LiveLogin>; profiles: CliProfile[] }> {
  const metas = await listMeta();
  const live: Record<Provider, LiveLogin> = { claude: null, codex: null };
  const activeKeys: Record<Provider, string | null> = { claude: null, codex: null };
  for (const provider of ["claude", "codex"] as const) {
    const login = await readLogin(provider, livePlace(provider));
    if (!login) continue;
    try {
      const who = await identify(login);
      activeKeys[provider] = who.key;
      live[provider] = { label: who.label, saved: metas.some((m) => m.provider === provider && m.key === who.key) };
    } catch (err) {
      live[provider] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  const profiles = metas.map((m) => ({ id: m.id, provider: m.provider, label: m.label, plan: m.plan, savedAt: m.savedAt, active: activeKeys[m.provider] === m.key }));
  return { live, profiles };
}

export async function saveCurrent(provider: Provider): Promise<void> {
  const login = await readLogin(provider, livePlace(provider));
  if (!login) {
    throw new Error(
      provider === "claude"
        ? "The Claude Code CLI is not signed in on this machine. Run `claude auth login` in a terminal first."
        : "The Codex CLI is not signed in on this machine. Run `codex login` in a terminal first.",
    );
  }
  await saveLogin(login);
}

/**
 * Keeps a saved login's copy in step with the CLI while it is the one in use:
 * the CLI rotates refresh tokens, so a copy left behind stops working, and a
 * copy in step is recognized without asking, even after its access token expires.
 */
export async function updateSavedCopy(provider: Provider): Promise<void> {
  const login = await readLogin(provider, livePlace(provider));
  if (!login || (await savedCopyOf(login))) return;
  const who = await identify(login).catch(() => null);
  // Only a login saved here already; saving a new one is the user's call.
  if (!who || !(await listMeta()).some((m) => m.provider === provider && m.key === who.key)) return;
  await saveLogin(login);
}

export async function switchTo(id: string): Promise<void> {
  const target = await getMeta(id);
  const live = livePlace(target.provider);
  const current = await readLogin(target.provider, live);
  // Never lose a login: the outgoing one is saved (or refreshed) before it is replaced.
  if (current) {
    const saved = await saveLogin(current);
    if (saved.id === id) return; // already active
  }
  const login = await readLogin(target.provider, profilePlace(target.provider, id));
  if (!login) throw new Error("That saved login has no credentials left. Save it again from the CLI.");
  await writeLogin(login, live);
}

export async function forget(id: string): Promise<void> {
  const meta = await getMeta(id);
  await rm(profilePlace(meta.provider, id).dir, { recursive: true, force: true });
}

/** The login's place and whether it is the one the CLI uses right now. */
async function placeFor(meta: Meta): Promise<{ place: Place; active: boolean }> {
  const active = (await liveKey(meta.provider)) === meta.key;
  return { place: active ? livePlace(meta.provider) : profilePlace(meta.provider, meta.id), active };
}

const REFRESH_AHEAD_MS = 5 * 60_000;

/**
 * An access token good for a usage read. Saved Claude logins expire within
 * hours, so an inactive one is refreshed here and written back to its own
 * copy; the live login is left for the CLI to refresh.
 */
async function usableToken(meta: Meta): Promise<{ token: string; accountId?: string }> {
  const { place, active } = await placeFor(meta);
  const login = await readLogin(meta.provider, place);
  if (!login) throw new Error("That saved login has no credentials left.");
  if (login.provider === "codex") {
    const t = login.auth.tokens as { access_token: string; account_id?: string };
    return { token: t.access_token, accountId: t.account_id };
  }
  const oauth = login.credentials.claudeAiOauth as { accessToken: string; refreshToken?: string; expiresAt?: number };
  if (active || !oauth.refreshToken || (oauth.expiresAt ?? Infinity) - Date.now() > REFRESH_AHEAD_MS) return { token: oauth.accessToken };
  const fresh = await refreshClaudeTokens(oauth.refreshToken);
  const credentials = {
    ...login.credentials,
    claudeAiOauth: { ...oauth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? oauth.refreshToken, expiresAt: fresh.expiresAt ?? oauth.expiresAt },
  };
  await writeJson(path.join(place.dir, ".credentials.json"), credentials);
  return { token: fresh.accessToken };
}

/**
 * When the running 5-hour session window resets, or null when none is
 * running (nothing used yet, so a hello would start one right away).
 */
export async function sessionResetAt(id: string): Promise<number | null> {
  const meta = await getMeta(id);
  const { token, accountId } = await usableToken(meta);
  const usage = meta.provider === "claude" ? await fetchClaudeUsage(token) : await fetchCodexUsage(token, accountId);
  const session = usage.windows.find(isSessionWindow);
  const reset = session?.resetsAt ? Date.parse(session.resetsAt) : NaN;
  if (!session || session.usedPercent <= 0 || Number.isNaN(reset) || reset <= Date.now()) return null;
  return reset;
}

const HELLO = "hello";
const HELLO_TIMEOUT_MS = 3 * 60_000;

/*
 * Finding the CLIs. A desktop app started from the Dock or the Start menu
 * does not get the PATH a terminal has (on macOS it is bare), so besides PATH
 * this looks in the login shell's PATH and the usual install folders, and
 * then at the copies the Claude and Codex desktop apps keep for themselves:
 * someone who only uses the desktop apps still has a CLI to run remote
 * sessions with. (The ignore comments stop the build from tracing, and
 * bundling, every file these paths could match.)
 */

let loginPath: string[] = [];

/** Reads the login shell's PATH once, in the background; until then the usual folders stand in. */
export function readLoginPath(): void {
  if (process.platform === "win32" || loginPath.length) return;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  execFile(/* turbopackIgnore: true */ shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5_000, windowsHide: true }, (err, out) => {
    const found = !err && /__PATH__(.*)__PATH__/.exec(String(out));
    if (found) loginPath = found[1].split(":").filter(Boolean);
  });
}

/** Where to look for a CLI, in order. */
function searchPath(): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  if (process.platform !== "win32") {
    const home = os.homedir();
    dirs.push(...loginPath, path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin"));
  }
  return [...new Set(dirs.filter(Boolean))];
}

function onPath(name: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of searchPath()) {
    for (const ext of exts) {
      const file = path.join(/* turbopackIgnore: true */ dir, name + ext.toLowerCase());
      if (existsSync(/* turbopackIgnore: true */ file)) return file;
    }
  }
  return null;
}

/** The newest x.y.z folder under `base` holding `file`. */
function newestIn(base: string | undefined, file: string): string | null {
  if (!base || !existsSync(/* turbopackIgnore: true */ base)) return null;
  const versions = readdirSync(/* turbopackIgnore: true */ base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const full = path.join(/* turbopackIgnore: true */ base, v, file);
    if (existsSync(/* turbopackIgnore: true */ full)) return full;
  }
  return null;
}

/** The copy of the CLI a desktop app keeps: Claude's per version under its app data, Codex's in its resources. */
function bundledCli(provider: Provider): string | null {
  const home = os.homedir();
  if (provider === "claude") {
    if (process.platform === "win32") return newestIn(process.env.APPDATA && path.join(process.env.APPDATA, "Claude", "claude-code"), "claude.exe");
    if (process.platform === "darwin") return newestIn(path.join(home, "Library", "Application Support", "Claude", "claude-code"), "claude");
    return null;
  }
  const candidates =
    process.platform === "win32"
      ? [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "resources", "codex.exe")]
      : process.platform === "darwin"
        ? ["/Applications/Codex.app/Contents/Resources/codex", path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")]
        : [];
  return candidates.find((f): f is string => Boolean(f) && existsSync(/* turbopackIgnore: true */ f!)) ?? null;
}

/**
 * How to start a CLI: its executable, and whether it needs a shell (Windows
 * resolves npm's claude.cmd / codex.cmd shims through one), or null when it
 * is nowhere to be found. A shim's name stays unquoted: cmd.exe resolves a
 * quoted one's %~dp0, which npm's shims rely on, to the working folder.
 */
export function findCli(provider: Provider): { bin: string; shell: boolean } | null {
  const found = onPath(provider);
  if (found) return process.platform === "win32" && !found.toLowerCase().endsWith(".exe") ? { bin: provider, shell: true } : { bin: found, shell: false };
  const bundled = bundledCli(provider);
  return bundled ? { bin: bundled, shell: false } : null;
}

/** The CLI to start, or its bare name when there is none, so starting it says it was not found. */
export const cliBin = (provider: Provider) => findCli(provider) ?? { bin: provider, shell: process.platform === "win32" };

/** Every running program's command line, one per line; empty when they can't be read. */
function commandLines(): Promise<string> {
  const [bin, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"]]
      : ["ps", ["-axww", "-o", "command="]];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? "" : String(out)));
  });
}

/**
 * Whether a program running on this computer has this conversation (`id`, a
 * SESSION_ID) open: its command line continues it, as the Claude app's
 * session for a chat it has open does (`claude --resume=<id>`), or a
 * terminal's `claude --resume <id>` and `codex resume <id>`. Such a program
 * keeps what was said to itself: a turn added from elsewhere is missing from
 * what it shows, and its next reply goes on without it.
 */
export async function conversationOpen(id: string): Promise<boolean> {
  return new RegExp(`(?:--resume|--session-id|-r|\\bresume)[=\\s]+"?${id}`, "i").test(await commandLines());
}

/**
 * Whether a CLI can run remote sessions here. Signed out only when that is
 * certain: on macOS Claude Code keeps its login in the Keychain, where this
 * does not look.
 */
export function toolState(provider: Provider, live: LiveLogin): ToolState {
  if (!findCli(provider)) return "missing";
  return live === null && (provider === "codex" || process.platform !== "darwin") ? "signed-out" : "ready";
}

/**
 * What to run in a terminal on this computer to sign a CLI in, with the copy
 * found here: its bare path works in cmd, PowerShell and sh alike, and only a
 * path with spaces needs quoting (the call operator, in PowerShell).
 */
export function signInCommand(provider: Provider): string {
  const found = findCli(provider);
  const path = !found || found.bin === provider ? provider : found.bin;
  const bin = !/\s/.test(path) ? path : process.platform === "win32" ? `& "${path}"` : `"${path}"`;
  return provider === "claude" ? `${bin} auth login` : `${bin} login`;
}

const HELLO_ARGS: Record<Provider, string[]> = {
  claude: ["-p", HELLO, "--model", "haiku", "--no-session-persistence", "--strict-mcp-config"],
  codex: ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", HELLO],
};

/**
 * The server's own environment may carry auth for a different account (e.g.
 * when started from inside a Claude session), and its own secrets, which the
 * CLI has no business seeing.
 */
function childEnv(provider: Provider, place: Place, active: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The folders the CLI was found in, for what it starts in turn (git, node): a desktop app's own PATH may be bare.
  if (process.platform !== "win32") env.PATH = searchPath().join(":");
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_|OPENAI_API_KEY$|CODEX_|APP_SECRET$|LIBSQL_|TURSO_|AICOOLDOWN_)/.test(k)) delete env[k];
  if (provider === "claude" && (!active || process.env.CLAUDE_CONFIG_DIR)) env.CLAUDE_CONFIG_DIR = place.dir;
  if (provider === "codex" && (!active || process.env.CODEX_HOME)) env.CODEX_HOME = place.dir;
  return env;
}

/** The environment for running the CLI as the login it uses now. */
export const liveEnv = (provider: Provider) => childEnv(provider, livePlace(provider), true);

/**
 * Sends "hello" through the provider's CLI as this login, which starts its
 * 5-hour session window. Resolves with the CLI's reply, rejects with its error.
 */
export async function sayHello(id: string): Promise<string> {
  const meta = await getMeta(id);
  const { place, active } = await placeFor(meta);
  const { bin, shell } = cliBin(meta.provider);
  return new Promise((resolve, reject) => {
    // An installed CLI, never a project file: the comment stops the build from tracing the whole project.
    const child = spawn(/* turbopackIgnore: true */ bin, HELLO_ARGS[meta.provider], {
      cwd: os.tmpdir(),
      env: childEnv(meta.provider, place, active),
      shell,
      windowsHide: true,
      timeout: HELLO_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.stdin.end(); // both CLIs otherwise wait for piped input
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "ENOENT" ? `The ${meta.provider === "claude" ? "Claude Code" : "Codex"} CLI was not found on PATH.` : e.message)),
    );
    child.on("close", (code) => {
      // The last lines, without colour codes or the CLI's timestamped log prefixes.
      const text = (s: string) =>
        s
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-2)
          .map((l) => l.replace(/^\S+Z\s+(ERROR|WARN|INFO)\s+\S+:\s*/, ""))
          .filter((l, i, all) => all.indexOf(l) === i)
          .join(" ")
          .slice(0, 300);
      if (code === 0) resolve(text(out) || "sent");
      else reject(new Error(text(err) || text(out) || (code === null ? "Timed out." : `The CLI exited with code ${code}.`)));
    });
  });
}
