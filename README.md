<p align="center"><img src="public/logo.svg" alt="AI Cooldown" width="360"></p>

# AI Cooldown

**[aicooldown.com](https://aicooldown.com)** · Know when your AI limits come back.

One dashboard for the usage limits of all your **Claude** (Pro/Max) and **ChatGPT / Codex** accounts: how much of each session and weekly window you have used, exactly when each cooldown ends, and which account to switch to.

- Connect as many accounts as you like, from either provider, and rename them however you want.
- Every rate-limit window the provider reports: 5-hour session, weekly, and per-model weekly limits (Fable, Opus, Sonnet), with the one that is currently limiting you flagged. Subscription shown per account (Max 5x, Pro, Plus, ...).
- **Go / Wait**: one verdict per provider. "Go · use iyed@personal · 82% session" or "Wait 2h 16m · every account is exhausted". Below it, accounts ranked by immediate headroom.
- **Daily budget** on every weekly window: how much you can spend per day and still reach the reset, next to what you have spent today.
- **Pace and projection** per window: a tick on each meter marks how far through the window you are (fill left of the tick means you are under pace), and your recent burn rate from local history projects whether you run dry before or after the reset.
- **History**: click any window for a 48-hour chart with hover readouts and reset markers, built from your own polling history and kept in the browser.
- **Notifications**: optional browser notifications when a limit resets, crosses 90%, or runs out (while the tab is open).
- **Tab title** shows the countdown to the reset you are waiting on, so a pinned tab is enough.
- **Copy status**: one click puts a plain-text summary of every account on the clipboard for pasting into chat.
- **Capacity returns**: every upcoming reset on one log-scale timeline (1 minute to 7 days), plus the next few as a list.
- Per-model availability and credit notices where Codex reports them.
- Rate-limit aware: Claude is polled every 3 minutes, Codex every minute, the server caches answers per token, a 429 serves the last good copy and backs off exponentially.
- **Optional account**: sign up with an email to keep linked accounts on the server (tokens encrypted at rest, never sent to the browser) and see them from any device. Or stay a guest and keep everything in this browser.
- **Light and dark** themes, following the OS by default.

## How it works

The app is a Next.js site. You connect a provider account either by signing in (OAuth with PKCE, the same public client the official CLIs use) or by pasting the token the CLI already saved on your machine. Where that token lives depends on whether you have an AI Cooldown account:

| | Guest (no sign-in) | Signed in |
| --- | --- | --- |
| Where linked accounts live | this browser's `localStorage` | the database, encrypted with `APP_SECRET` |
| Where provider tokens go | sent with each usage request to the site's proxy | never leave the server; the browser asks by account id |
| Other devices | no | yes |
| Polling history and theme | this browser | this browser |

Guest mode needs no database. Signing up takes an email and a password (scrypt-hashed, session cookie, no third-party auth service). When you first sign in, accounts already in the browser can be moved over with one click.

On a schedule (Claude every 3 minutes, Codex every minute) the browser asks `/api/usage` for each account; the server calls the provider's usage endpoint, refreshes tokens it owns when they are about to expire, keeps a short in-memory cache per token so repeated requests do not hit the provider, and if the provider answers 429 returns the last good copy marked stale.

Anthropic rate-limits its usage endpoint per access token, sends no Retry-After, and a tripped limit can last hours. If you see "rate-limiting this token" on a card, the dashboard keeps showing the last data it got and retries with growing delays (5, 10, 20, 30 minutes). Avoid running several usage tools against the same token at once.

If you use the hosted instance, your tokens pass through that server in transit. If you do not want that, host your own copy (it is a one-click deploy) or run it locally.

### Sign in vs. import

| Method | What is stored | Refreshes itself? |
| --- | --- | --- |
| **Sign in** | Access + refresh token issued to this app | Yes. The app owns the session, so it refreshes before expiry. |
| **Import CLI token** | Access token only | No. Both providers rotate refresh tokens on use, so refreshing an imported token here would log your CLI out. When it expires (Claude: ~8 hours, Codex: days), import it again. |

Where the CLIs keep their tokens:

| Provider | File | Notes |
| --- | --- | --- |
| Claude Code | `~/.claude/.credentials.json` | On macOS the live token is in Keychain (item `Claude Code-credentials`) and the file can be stale. |
| Codex CLI | `~/.codex/auth.json` | Written by `codex login`. |

Paste the whole file, or just the access token.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Guest mode works with no configuration. Sign-up works too: the database is a SQLite file created at `data/aicooldown.db`, and a development encryption key is used with a console warning.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/iyedbhd/aicooldown&env=APP_SECRET,LIBSQL_URL,LIBSQL_AUTH_TOKEN)

Environment variables for a hosted instance:

| Variable | Required | What |
| --- | --- | --- |
| `APP_SECRET` | yes, in production | 32+ random characters. Encrypts stored provider tokens. Changing it makes existing stored tokens unreadable. |
| `LIBSQL_URL` | yes, on serverless hosts | libSQL database URL, e.g. a free [Turso](https://turso.tech) database (`libsql://...`). Defaults to `file:data/aicooldown.db`, which does not persist on Vercel. Vercel's Turso Marketplace integration sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` instead, which are accepted too. |
| `LIBSQL_AUTH_TOKEN` | with Turso | The database auth token. |

Any host that runs Next.js works (Vercel, Netlify, a Node server, Docker). The API routes need outbound HTTPS access to `api.anthropic.com`, `platform.claude.com`, `chatgpt.com` and `auth.openai.com`.

## Endpoints used

These are the same endpoints the official CLIs call. They are not publicly documented and may change without notice.

| Provider | Usage | Auth |
| --- | --- | --- |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` (+ `/api/oauth/profile` for the account email) | `https://claude.ai/oauth/authorize` → `https://platform.claude.com/v1/oauth/token` |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | `https://auth.openai.com/oauth/authorize` → `https://auth.openai.com/oauth/token` |

## Project layout

```
src/app/api/usage            usage for a stored account (by id) or a guest account (tokens in body)
src/app/api/accounts         signed-in CRUD for linked accounts
src/app/api/auth/*           register, login, logout, me, PKCE code exchange
src/app/api/identity         account email / plan for a guest token
src/lib/providers/*.ts       per-provider endpoints and response normalization
src/lib/server/usage.ts      fetch + refresh-on-expiry + cache, shared by both callers
src/lib/server/{db,auth,accounts,crypto}.ts
                             libSQL schema, sessions, encrypted account storage
src/lib/store.ts             browser-side account store: localStorage or the API
src/components/*             dashboard UI
```

## Brand

The name, tagline and domain live in `src/lib/site.ts`. Logo files are in `public/` (`mark.svg`, `logo.svg`) and `src/app/icon.svg` (favicon); the `/brand` page shows them with the color tokens.

## Disclaimer

This project is not affiliated with Anthropic or OpenAI. The Claude and OpenAI marks shown next to accounts are their owners' trademarks, used only to identify each provider (glyphs via [Simple Icons](https://simpleicons.org)). It reads your own account's usage data with your own credentials. Use at your own risk and keep your tokens private: anyone who has them can act as you.

## License

MIT
