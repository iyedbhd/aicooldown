"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ADMINS, audiencesOf, manages, teamAudience, userAudience, type Audience, type SharingChange, type Workspace } from "@/lib/team";
import { Icon } from "./Icon";
import { Avatar } from "./TeamBits";

type Props = {
  ws: Workspace;
  kind: "project" | "session";
  /** The project's name, or the session's key. */
  item: string;
  /** For a session: its project, whose audiences it has too. */
  project?: string;
  onShare: (change: SharingChange) => Promise<void>;
};

/**
 * Whom one of your projects or chats is shared with in this team, and a menu
 * to change it: the team's other owners and admins (for an owner or admin),
 * everyone in the team, or people you pick. The owners and admins of a
 * member's team see all of their work whatever this says, and it says so.
 */
export function ShareMenu({ ws, kind, item, project, onShare }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Audience | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      e.stopImmediatePropagation();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  if (!ws.team || !ws.role) return null;
  const team = ws.team;
  const runs = manages(ws.role);
  const own = audiencesOf(ws.shares, kind, item);
  const inherited = kind === "session" && project ? audiencesOf(ws.shares, "project", project) : [];
  const reach = new Set([...own, ...inherited]);
  const everything = runs && ws.shares.all;
  const others = ws.members.filter((m) => m.id !== ws.me.id);
  // A member's owners and admins see all of their work already.
  const managers = new Set(ws.role === "member" ? others.filter((m) => manages(m.role)).map((m) => m.id) : []);
  const people = others.filter((m) => reach.has(userAudience(m.id))).length;
  const parts = [
    reach.has(teamAudience(team.id)) ? `everyone in ${team.name}` : null,
    reach.has(ADMINS) || everything ? "owners and admins" : null,
    people ? `${people} ${people === 1 ? "person" : "people"}` : null,
  ].filter(Boolean);
  const shared = parts.length > 0;

  async function toggle(audience: Audience) {
    setBusy(audience);
    const shared = !own.includes(audience);
    await onShare(kind === "project" ? { project: item, audience, shared } : { session: item, audience, shared });
    setBusy(null);
  }

  const row = (audience: Audience, label: ReactNode, locked?: string) => {
    const via = inherited.includes(audience) && !own.includes(audience) ? "with its project" : null;
    const why = locked ?? via;
    return (
      <label key={audience} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${why ? "text-muted" : "cursor-pointer text-fg-2 hover:bg-panel-2"}`}>
        <input type="checkbox" checked={Boolean(locked) || reach.has(audience)} disabled={busy !== null || Boolean(why)} onChange={() => void toggle(audience)} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{label}</span>
        {busy === audience ? <span className="font-mono text-[10px] text-faint">…</span> : why && <span className="shrink-0 text-[10px] text-faint">{why}</span>}
      </label>
    );
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={shared ? `Shared with ${parts.join(", ")}` : "Only you see it. Pick whom to share it with."}
        className={`chip transition hover:brightness-95 ${shared ? "chip-good" : ""}`}
      >
        <Icon name={shared ? "eye" : "lock"} size={11} />
        {shared ? (parts.length === 1 ? `shared with ${parts[0]}` : `shared with ${parts.length} groups`) : "share"}
      </button>
      {open && (
        <div role="dialog" aria-label="Share with" className="absolute right-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-panel p-1.5 text-left shadow-xl">
          <p className="px-2 pb-1 pt-0.5 text-[11px] text-faint">
            Share {kind === "project" ? <span className="text-fg-2">{item}</span> : "this chat"} with{kind === "project" ? " (on all your computers)" : ""}
          </p>
          {runs && row(ADMINS, "The team's other owners and admins", everything ? "you share everything with them" : undefined)}
          {row(teamAudience(team.id), `Everyone in ${team.name}`)}
          {others.length > 0 && (
            <div className="mt-1 max-h-56 overflow-y-auto border-t border-line pt-1">
              {others.map((m) =>
                row(
                  userAudience(m.id),
                  <>
                    <Avatar email={m.email} size={16} />
                    <span className="truncate">{m.email}</span>
                  </>,
                  managers.has(m.id) ? "sees all your work" : undefined,
                ),
              )}
            </div>
          )}
          <p className="px-2 pb-0.5 pt-1.5 text-[10px] text-faint">
            They see its sessions, and what those say where your computer lets that reach the website.{" "}
            {runs
              ? "Owners and admins it reaches may also continue them where your computer allows remote sessions; nobody else can."
              : "Only you and the team's owner and admins start or continue sessions in it."}
          </p>
        </div>
      )}
    </div>
  );
}
