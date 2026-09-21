"use client";

import { useEffect, useState } from "react";
import { postJson } from "@/lib/api";
import { parseImport } from "@/lib/import";
import { createPkce, type Pkce } from "@/lib/pkce";
import { claudeAuthorizeUrl } from "@/lib/providers/claude";
import { codexAuthorizeUrl, codexIdentityFromTokens } from "@/lib/providers/codex";
import type { NewAccount } from "@/lib/store";
import type { Identity, Provider, TokenSet } from "@/lib/types";
import { PROVIDER_META, ProviderTile } from "./ProviderLogo";

type Method = "signin" | "import";

const DEFAULT_LABEL: Record<Provider, string> = { claude: "Claude account", codex: "Codex account" };

const IMPORT_HELP: Record<Provider, { path: string; note: string }> = {
  claude: {
    path: "~/.claude/.credentials.json",
    note: "On macOS the live token is in Keychain (item “Claude Code-credentials”); the file may be stale. You can also paste a bare sk-ant-oat01-… access token.",
  },
  codex: {
    path: "~/.codex/auth.json",
    note: "Created by `codex login`. You can also paste a bare access token.",
  },
};

function parseCodexCallback(text: string, expectedState: string): string {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed; // assume a bare code
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new Error("That URL has no ?code= parameter.");
  if (state && state !== expectedState) throw new Error("State mismatch. Start the sign-in again.");
  return code;
}

export function AddAccountDialog({ onAdd, onClose }: { onAdd: (account: NewAccount) => Promise<void>; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>("claude");
  const [method, setMethod] = useState<Method>("signin");
  const [pkce, setPkce] = useState<Pkce | null>(null);
  const [pasted, setPasted] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function reset(next: Partial<{ provider: Provider; method: Method }>) {
    if (next.provider) setProvider(next.provider);
    if (next.method) setMethod(next.method);
    setPkce(null);
    setPasted("");
    setError(null);
  }

  async function openSignIn() {
    setError(null);
    const p = await createPkce();
    setPkce(p);
    const url = provider === "claude" ? claudeAuthorizeUrl(p.challenge, p.state) : codexAuthorizeUrl(p.challenge, p.state);
    window.open(url, "_blank", "noopener");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let tokens: TokenSet;
      let owned: boolean;
      if (method === "signin") {
        if (!pkce) throw new Error("Open the sign-in page first.");
        const code = provider === "codex" ? parseCodexCallback(pasted, pkce.state) : pasted.trim();
        if (!code) throw new Error("Paste the code first.");
        const res = await postJson<TokenSet>("/api/auth/exchange", {
          provider,
          code,
          state: pkce.state,
          verifier: pkce.verifier,
        });
        if (!res.ok) throw new Error(res.error);
        tokens = res.data;
        owned = true;
      } else {
        const imported = parseImport(provider, pasted);
        let identity: Identity = {};
        if (provider === "codex") {
          identity = codexIdentityFromTokens(imported.accessToken, imported.idToken);
        } else {
          const res = await postJson<Identity>("/api/identity", { provider, accessToken: imported.accessToken });
          if (res.ok) identity = res.data;
          else if (res.status === 401) throw new Error(res.error);
          // Anything else (e.g. a 429) must not block adding: the dashboard fills in the plan later.
        }
        tokens = {
          ...imported,
          ...identity,
          plan: identity.plan ?? imported.plan,
          accountId: identity.accountId ?? imported.accountId,
        };
        owned = false;
      }
      await onAdd({
        provider,
        label: label.trim() || tokens.email || DEFAULT_LABEL[provider],
        plan: tokens.plan,
        accessToken: tokens.accessToken,
        refreshToken: owned ? tokens.refreshToken : undefined,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
        owned,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const tab = (active: boolean) =>
    `px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition ${active ? "bg-panel-3 text-fg" : "bg-panel text-muted hover:bg-panel-2 hover:text-fg-2"}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="add-account-title" className="w-full max-w-lg rounded-2xl border border-line bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 id="add-account-title" className="text-lg font-semibold text-fg">
            Add account
          </h2>
          <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          {(["claude", "codex"] as const).map((p) => {
            const active = provider === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => reset({ provider: p })}
                aria-pressed={active}
                className={`flex items-center gap-3 p-3 text-left transition ${active ? "bg-panel-3" : "bg-panel hover:bg-panel-2"}`}
              >
                <ProviderTile provider={p} size={36} />
                <span>
                  <span className={`block text-sm font-medium ${active ? "text-fg" : "text-fg-2"}`}>{PROVIDER_META[p].product}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-wider text-muted">{PROVIDER_META[p].vendor}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <button type="button" className={`flex-1 ${tab(method === "signin")}`} onClick={() => reset({ method: "signin" })}>
            Sign in
          </button>
          <button type="button" className={`flex-1 ${tab(method === "import")}`} onClick={() => reset({ method: "import" })}>
            Import CLI token
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-4 text-sm text-fg-2">
          {method === "signin" ? (
            <>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>
                  <button
                    type="button"
                    onClick={openSignIn}
                    className="btn btn-primary"
                  >
                    Open {provider === "claude" ? "Claude" : "ChatGPT"} sign-in
                  </button>
                  <span className="ml-2 text-muted">(opens in a new tab)</span>
                </li>
                {provider === "claude" ? (
                  <li>Approve access. Claude shows a code on the final page. Copy it and paste it below.</li>
                ) : (
                  <li>
                    Approve access. Your browser is sent to <code className="text-muted">localhost:1455</code>, which will fail to load.
                    That is expected. Copy the full URL from the address bar and paste it below.
                  </li>
                )}
              </ol>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={3}
                placeholder={provider === "claude" ? "Paste the code here" : "http://localhost:1455/auth/callback?code=…&state=…"}
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-muted focus:outline-none"
                disabled={!pkce}
              />
              <p className="text-xs text-muted">
                This app keeps its own session, so it can refresh the token itself without touching your CLI login.
              </p>
            </>
          ) : (
            <>
              <p>
                Paste the contents of <code className="text-fg">{IMPORT_HELP[provider].path}</code>.{" "}
                <span className="text-muted">{IMPORT_HELP[provider].note}</span>
              </p>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={6}
                placeholder="{ … }"
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-muted focus:outline-none"
              />
              <p className="text-xs text-muted">
                Only the access token is kept. Imported tokens are never refreshed here, because both providers rotate refresh
                tokens and that would log your CLI out. When it expires, import it again.
              </p>
            </>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Label (optional, defaults to the account email)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work, personal, …"
              className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none"
            />
          </label>

          {error && <p className="border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !pasted.trim()}
              className="btn btn-primary"
            >
              {busy ? "Connecting…" : "Add account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
