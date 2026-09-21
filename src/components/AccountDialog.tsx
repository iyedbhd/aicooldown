"use client";

import { useEffect, useState } from "react";
import { changePassword, deleteAccount, signOutOtherDevices, type SessionUser } from "@/lib/session";
import { Icon } from "./Icon";

type Props = {
  user: SessionUser;
  linkedCount: number;
  onClose: () => void;
  onNote: (text: string) => void;
  onDeleted: () => void;
};

const input = "w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";

/** Signed-in account settings: change password, sign out other devices, delete the account. */
export function AccountDialog({ user, linkedCount, onClose, onNote, onDeleted }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [busy, setBusy] = useState<"password" | "devices" | "delete" | null>(null);
  const [error, setError] = useState<{ where: "password" | "devices" | "delete"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(where: "password" | "devices" | "delete", action: () => Promise<void>) {
    setBusy(where);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError({ where, text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError({ where: "password", text: "The new passwords do not match." });
      return;
    }
    void run("password", async () => {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      onNote("Password changed. Other devices were signed out.");
    });
  }

  function submitDelete(e: React.FormEvent) {
    e.preventDefault();
    void run("delete", async () => {
      await deleteAccount(deletePassword);
      onDeleted();
    });
  }

  const errorLine = (where: "password" | "devices" | "delete") =>
    error?.where === where ? <p className="mt-3 border-l-2 border-rose-500/70 pl-2 text-xs text-rose-600 dark:text-rose-400">{error.text}</p> : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="account-title" className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border border-line bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 id="account-title" className="text-lg font-semibold text-fg">
              Your account
            </h2>
            <p className="truncate font-mono text-[11px] text-muted">{user.email}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-muted hover:text-fg" aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={submitPassword} className="mt-5">
          <p className="eyebrow">change password</p>
          <label className="mt-2 block">
            <span className="text-xs text-muted">current password</span>
            <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="mt-2 block">
            <span className="text-xs text-muted">new password · 8+ characters</span>
            <input type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="mt-2 block">
            <span className="text-xs text-muted">new password again</span>
            <input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          {errorLine("password")}
          <button type="submit" disabled={busy !== null} className="btn btn-primary mt-3 w-full justify-center">
            {busy === "password" ? "…" : "Change password"}
          </button>
          <p className="mt-2 text-[11px] text-faint">Changing it signs out every other device. This one stays signed in.</p>
        </form>

        <div className="mt-6 border-t border-line pt-5">
          <p className="eyebrow">devices</p>
          <p className="mt-2 text-xs text-muted">Signed in somewhere you do not recognise, or on a machine you no longer have? Sign the others out; this one stays.</p>
          {errorLine("devices")}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("devices", async () => {
                const n = await signOutOtherDevices();
                onNote(n === 0 ? "No other devices were signed in." : `Signed out ${n} other device${n === 1 ? "" : "s"}.`);
              })
            }
            className="btn mt-3"
          >
            <Icon name="logout" />
            {busy === "devices" ? "…" : "Sign out other devices"}
          </button>
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <p className="eyebrow text-rose-600 dark:text-rose-400">delete account</p>
          <p className="mt-2 text-xs text-muted">
            Removes your {`${user.email}`} account, its sessions, and the {linkedCount} linked provider account{linkedCount === 1 ? "" : "s"} stored on the server. Your
            Claude and ChatGPT subscriptions are not affected. This cannot be undone.
          </p>
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className="btn mt-3 border-rose-500/40 text-rose-600 hover:border-rose-500 dark:text-rose-400">
              <Icon name="trash" />
              Delete my account
            </button>
          ) : (
            <form onSubmit={submitDelete} className="mt-3">
              <label className="block">
                <span className="text-xs text-muted">your password, to confirm</span>
                <input type="password" required autoFocus autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} className={`mt-1 ${input}`} />
              </label>
              {errorLine("delete")}
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn">
                  Keep it
                </button>
                <button type="submit" disabled={busy !== null} className="btn border-rose-500 bg-rose-500 text-white hover:opacity-90">
                  {busy === "delete" ? "…" : "Delete for good"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
