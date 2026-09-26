"use client";

import { useEffect, useId, useState } from "react";
import { fetchLocalState } from "@/lib/local";
import { signIn, type SessionUser } from "@/lib/session";
import { SITE } from "@/lib/site";
import { CloseButton, Modal } from "./Modal";

type Mode = "login" | "register";

type Props = { onSignedIn: (user: SessionUser) => void; onClose: () => void; localCount: number };

export function AuthDialog({ onSignedIn, onClose, localCount }: Props) {
  const titleId = useId();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server accounts live on when this copy forwards them there (the desktop app: aicooldown.com). */
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchLocalState().then((local) => alive && setServer(local?.accountsServer ?? null));
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(mode, email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const tab = (active: boolean) =>
    `px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition ${active ? "bg-panel-3 text-fg" : "bg-panel text-muted hover:bg-panel-2 hover:text-fg-2"}`;
  const input = "w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";

  return (
    <Modal onClose={onClose} labelledBy={titleId} className="max-w-sm p-6">
      <form onSubmit={submit}>
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold text-fg">
            {mode === "login" ? "Sign in" : "Create account"}
          </h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <button type="button" aria-pressed={mode === "login"} className={tab(mode === "login")} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button type="button" aria-pressed={mode === "register"} className={tab(mode === "register")} onClick={() => setMode("register")}>
            Register
          </button>
        </div>

        <p className="mt-4 text-xs text-muted">
          {server
            ? `This is your ${SITE.name} account on ${server}, the same one as on the website. It keeps your linked accounts there, encrypted,`
            : "Signing in keeps your linked accounts on the server, encrypted,"}{" "}
          so you see them from any device and the provider tokens never sit in a browser.
          {localCount > 0 && ` The ${localCount} account${localCount === 1 ? "" : "s"} in this browser can be moved over after you sign in.`}
        </p>

        <label className="mt-4 block">
          <span className="eyebrow">email</span>
          <input type="email" required autoComplete="email" data-autofocus value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        <label className="mt-3 block">
          <span className="eyebrow">password{mode === "register" ? " · 8+ characters" : ""}</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`mt-1 ${input}`}
          />
        </label>

        {error && <p className="mt-3 border-l-2 border-rose-500/70 pl-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary mt-5 w-full justify-center"
        >
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </Modal>
  );
}
