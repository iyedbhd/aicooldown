import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliProfile } from "@/lib/local";
import { claudePlanLabel, fetchClaudeIdentity, fetchClaudeUsage, refreshClaudeTokens } from "@/lib/providers/claude";
import { codexIdentityFromTokens, fetchCodexUsage } from "@/lib/providers/codex";
import { isSessionWindow } from "@/lib/stats";
import type { Provider } from "@/lib/types";

/**
 * Account switching the way the CLIs allow it: each saved login is a copy of
 * the CLI's own credential files under data/cli-profiles. Switching writes
 * the live files back into the outgoing login's copy (the CLI rotates refresh
 * tokens, so the live copy is the newest) and then puts the chosen copy in
 * place. A login's tokens are only ever used from one place at a time: the
 * live files while active, its own directory otherwise, where the CLI can
 * still run against it through CLAUDE_CONFIG_DIR / CODEX_HOME.
 */

const PROFILES_DIR = path.join(process.cwd(), "data", "cli-profiles");

/** Raw credential objects, kept verbatim so the CLI reads back exactly what it wrote. */
type Login =
  | { provider: "claude"; credentials: Record<string, unknown>; oauthAccount?: Record<string, unknown> }
  | { provider: "codex"; auth: Record<string, unknown> };

type Meta = { id: string; provider: Provider; key: string; label: string; plan?: string; savedAt: number };

/** Where a login lives: the CLI's live files, or a saved profile directory. */
type Place = { dir: string; claudeConfig: string };

function livePlace(provider: Provider): Place {
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

function accessToken(login: Login): string {
  if (login.provider === "codex") return (login.auth.tokens as { access_token: string }).access_token;
  return (login.credentials.claudeAiOauth as { accessToken: string }).accessToken;
}

/** A stable key for "the same account", independent of token rotation. */
async function identify(login: Login): Promise<{ key: string; label: string; plan?: string }> {
  if (login.provider === "codex") {
    const t = login.auth.tokens as { access_token: string; id_token?: string; account_id?: string };
    const id = codexIdentityFromTokens(t.access_token, t.id_token);
    const email = id.email ?? "Codex login";
    return { key: `${t.account_id ?? id.accountId ?? ""}:${email}`, label: email, plan: id.plan };
  }
  const oauth = login.credentials.claudeAiOauth as { subscriptionType?: string; rateLimitTier?: string };
  const plan = claudePlanLabel({ subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier });
  const acct = login.oauthAccount as { accountUuid?: string; organizationUuid?: string; emailAddress?: string } | undefined;
  if (acct?.accountUuid) return { key: `${acct.accountUuid}:${acct.organizationUuid ?? ""}`, label: acct.emailAddress ?? "Claude login", plan };
  const email = (await fetchClaudeIdentity(accessToken(login)).catch(() => ({ email: undefined }))).email;
  if (!email) throw new Error("Could not tell which Claude account this login belongs to.");
  return { key: email, label: email, plan };
}

const profileId = (provider: Provider, key: string) => createHash("sha256").update(`${provider}:${key}`).digest("hex").slice(0, 12);

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
  await writeLogin(login, place);
  const meta: Meta = { id, provider: login.provider, key: who.key, label: who.label, plan: who.plan, savedAt: previous?.savedAt ?? Date.now() };
  await writeJson(path.join(place.dir, "profile.json"), meta);
  return meta;
}

async function liveKey(provider: Provider): Promise<string | null> {
  const login = await readLogin(provider, livePlace(provider));
  return login ? (await identify(login).catch(() => null))?.key ?? null : null;
}

export async function liveState(): Promise<{
  live: Record<Provider, { label: string; saved: boolean } | null>;
  profiles: CliProfile[];
}> {
  const metas = await listMeta();
  const live: Record<Provider, { label: string; saved: boolean } | null> = { claude: null, codex: null };
  const activeKeys: Record<Provider, string | null> = { claude: null, codex: null };
  for (const provider of ["claude", "codex"] as const) {
    const login = await readLogin(provider, livePlace(provider));
    const who = login ? await identify(login).catch(() => null) : null;
    if (!who) continue;
    activeKeys[provider] = who.key;
    live[provider] = { label: who.label, saved: metas.some((m) => m.provider === provider && m.key === who.key) };
  }
  const profiles = metas.map((m) => ({ id: m.id, provider: m.provider, label: m.label, plan: m.plan, savedAt: m.savedAt, active: activeKeys[m.provider] === m.key }));
  return { live, profiles };
}

export async function saveCurrent(provider: Provider): Promise<void> {
  const login = await readLogin(provider, livePlace(provider));
  if (!login) {
    throw new Error(
      provider === "claude"
        ? "No Claude Code CLI login found (~/.claude/.credentials.json). Run `claude` in a terminal and /login first."
        : "No Codex CLI login found (~/.codex/auth.json). Run `codex login` first.",
    );
  }
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

function cliCommand(provider: Provider): { bin: string; args: string[] } {
  if (provider === "claude") return { bin: "claude", args: ["-p", HELLO, "--model", "haiku", "--no-session-persistence", "--strict-mcp-config"] };
  // The Codex desktop app on Windows bundles the CLI without putting it on PATH.
  const bundled = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "resources", "codex.exe");
  const bin = process.platform === "win32" && bundled && existsSync(bundled) ? bundled : "codex";
  return { bin, args: ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", HELLO] };
}

/** The server's own environment may carry auth for a different account (e.g. when started from inside a Claude session). */
function childEnv(provider: Provider, place: Place, active: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_|OPENAI_API_KEY$|CODEX_)/.test(k)) delete env[k];
  if (provider === "claude" && (!active || process.env.CLAUDE_CONFIG_DIR)) env.CLAUDE_CONFIG_DIR = place.dir;
  if (provider === "codex" && (!active || process.env.CODEX_HOME)) env.CODEX_HOME = place.dir;
  return env;
}

/**
 * Sends "hello" through the provider's CLI as this login, which starts its
 * 5-hour session window. Resolves with the CLI's reply, rejects with its error.
 */
export async function sayHello(id: string): Promise<string> {
  const meta = await getMeta(id);
  const { place, active } = await placeFor(meta);
  const { bin, args } = cliCommand(meta.provider);
  const shell = process.platform === "win32" && !bin.endsWith(".exe"); // resolves claude.cmd / codex.cmd shims
  return new Promise((resolve, reject) => {
    const child = spawn(shell ? `"${bin}"` : bin, args, {
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
