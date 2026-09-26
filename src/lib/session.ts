import { postJson } from "./api";

export type SessionUser = { id: string; email: string };

const SESSION_EVENT = "aic:session";

/**
 * Called whenever this page signs in, signs out or deletes the account, from
 * any page: the usage engine (lib/usage/engine.ts) and the Team page follow.
 */
export function onSessionChange(listener: () => void): () => void {
  window.addEventListener(SESSION_EVENT, listener);
  return () => window.removeEventListener(SESSION_EVENT, listener);
}

const announce = () => window.dispatchEvent(new Event(SESSION_EVENT));

/** The signed-in user, null when signed out, or undefined when that cannot be told right now (offline, server down). */
export async function checkSession(): Promise<SessionUser | null | undefined> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { user: SessionUser | null };
    return json.user;
  } catch {
    return undefined;
  }
}

export async function fetchSession(): Promise<SessionUser | null> {
  return (await checkSession()) ?? null;
}

export async function signIn(mode: "login" | "register", email: string, password: string): Promise<SessionUser> {
  const res = await postJson<{ user: SessionUser }>(`/api/auth/${mode}`, { email, password });
  if (!res.ok) throw new Error(res.error);
  announce();
  return res.data.user;
}

export async function signOut(): Promise<void> {
  await postJson("/api/auth/logout", {});
  announce();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await postJson("/api/auth/password", { currentPassword, newPassword });
  if (!res.ok) throw new Error(res.error);
}

/** Signs out every other device; returns how many sessions were removed. */
export async function signOutOtherDevices(): Promise<number> {
  const res = await fetch("/api/auth/sessions", { method: "DELETE" });
  const json = (await res.json().catch(() => ({}))) as { removed?: number; error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.removed ?? 0;
}

export async function deleteAccount(password: string): Promise<void> {
  const res = await postJson("/api/auth/delete", { password });
  if (!res.ok) throw new Error(res.error);
  announce();
}
