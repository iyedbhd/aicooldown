"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/format";
import { fetchSession, signOut, type SessionUser } from "@/lib/session";
import { acceptInvite, previewInvite, type InvitePreview } from "@/lib/team";
import { AuthDialog } from "./AuthDialog";
import { Icon } from "./Icon";
import { Mark, Wordmark } from "./Logo";
import { RoleBadge } from "./TeamBits";

/** An invite link: which team it is for, what joining shares, and joining it signed in. */
export function JoinTeam({ token }: { token: string }) {
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [showAuth, setShowAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const router = useRouter();

  useEffect(() => {
    let alive = true;
    void Promise.all([previewInvite(token), fetchSession()]).then(([preview, me]) => {
      if (!alive) return;
      if (preview.ok) setInvite(preview.data);
      else setProblem(preview.error);
      setUser(me);
    });
    return () => {
      alive = false;
    };
  }, [token]);

  async function join() {
    setBusy(true);
    setError(null);
    const res = await acceptInvite(token);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/team?team=${encodeURIComponent(res.data.teamId)}`);
  }

  async function switchAccount() {
    await signOut();
    setUser(null);
    setShowAuth(true);
  }

  const wrongAccount = Boolean(invite?.email && user && user.email !== invite.email);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-6 flex items-center justify-center gap-3">
        <Mark size={36} />
        <span className="text-xl">
          <Wordmark />
        </span>
      </Link>
      <section className="fade-in rounded-2xl border border-line bg-panel p-6 shadow-sm">
        {problem ? (
          <>
            <h1 className="text-lg font-semibold text-fg">This invite does not work</h1>
            <p className="mt-2 text-sm text-muted">{problem}</p>
            <Link href="/" className="btn mt-5">
              Go to the dashboard
            </Link>
          </>
        ) : !invite || user === undefined ? (
          <div className="space-y-3" aria-label="Loading">
            <div className="shimmer h-6 w-2/3 rounded" />
            <div className="shimmer h-16 rounded" />
          </div>
        ) : (
          <>
            <p className="eyebrow">team invite</p>
            <h1 className="mt-2 text-xl font-semibold text-fg">Join {invite.team}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              {invite.by ? `${invite.by} invited ${invite.email ?? "you"}` : `An invite for ${invite.email ?? "you"}`} as <RoleBadge role={invite.role} />
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-faint">expires in {formatCountdown(invite.expiresAt - now)}</p>

            <div className="mt-5 rounded-xl border border-line bg-panel-2 px-4 py-3 text-sm text-fg-2">
              <p className="flex items-center gap-2 font-medium text-fg">
                <Icon name="shield" size={14} />
                What the team&apos;s owner and admins see
              </p>
              {invite.role === "member" ? (
                <>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted">
                    <li>the computers you connect, and which accounts their Claude Code and Codex CLIs use</li>
                    <li>every Claude Code and Codex session there: its project and branch, when and where it ran, its models and tokens</li>
                    <li>what those sessions say: their titles and conversations, which they can also continue</li>
                    <li>the projects you work on there, with token counts per day and model</li>
                    <li>the limits of the Claude and Codex accounts linked to your AI Cooldown account</li>
                    <li>remote Claude Code and Codex sessions on your computers, which they can start only where you allow it</li>
                  </ul>
                  <p className="mt-2 text-[12px] text-faint">
                    As a member you show them all of your work: your computers let what your sessions say reach them while you are one. The other members
                    see only what you share with them. Never your account credentials. Leave the team any time.
                  </p>
                </>
              ) : (
                <>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted">
                    <li>the computers you connect, and which accounts their Claude Code and Codex CLIs use</li>
                    <li>the limits of the Claude and Codex accounts linked to your AI Cooldown account</li>
                    <li>of your projects and sessions, only the ones you share with them: you pick them, and with whom, on the Team page</li>
                  </ul>
                  <p className="mt-2 text-[12px] text-faint">
                    As an {invite.role} you see all of the members&apos; work, and everyone in the team sees what you share with them. Never your account
                    credentials. Leave the team any time.
                  </p>
                </>
              )}
            </div>

            {error && <p className="mt-4 border-l-2 border-rose-500/70 pl-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

            {user ? (
              <div className="mt-5 space-y-2">
                {wrongAccount && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    This invite is for {invite.email}; you are signed in as {user.email}.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void join()} disabled={busy || wrongAccount} className="btn btn-primary">
                    <Icon name="users" />
                    {busy ? "Joining…" : `Join as ${user.email}`}
                  </button>
                  <button type="button" onClick={() => void switchAccount()} className="btn">
                    Use another account
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <button type="button" onClick={() => setShowAuth(true)} className="btn btn-primary">
                  <Icon name="user" />
                  Sign in or create an account to join
                </button>
                {invite.email && <p className="mt-2 text-[11px] text-faint">Use {invite.email}: the invite only works for that account.</p>}
              </div>
            )}
          </>
        )}
      </section>
      {showAuth && (
        <AuthDialog
          localCount={0}
          onClose={() => setShowAuth(false)}
          onSignedIn={(u) => {
            setShowAuth(false);
            setUser(u);
          }}
        />
      )}
    </main>
  );
}
