import { postJson } from "./api";

export type SessionUser = { id: string; email: string };

export async function fetchSession(): Promise<SessionUser | null> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { user: SessionUser | null };
    return json.user;
  } catch {
    return null;
  }
}

export async function signIn(mode: "login" | "register", email: string, password: string): Promise<SessionUser> {
  const res = await postJson<{ user: SessionUser }>(`/api/auth/${mode}`, { email, password });
  if (!res.ok) throw new Error(res.error);
  return res.data.user;
}

export async function signOut(): Promise<void> {
  await postJson("/api/auth/logout", {});
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
}
