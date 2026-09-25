import type { ReactNode } from "react";
import { formatAgo } from "@/lib/format";
import type { Role, RunStatus } from "@/lib/team";

/** Small pieces the team page shares. */

/** A person's initial on a tile tinted from their email, so the same person looks the same everywhere. */
export function Avatar({ email, size = 28 }: { email: string; size?: number }) {
  let hash = 0;
  for (const c of email) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `oklch(0.55 0.12 ${hash % 360})` }}
      aria-hidden
    >
      {email.slice(0, 1).toUpperCase()}
    </span>
  );
}

const ROLE_STYLE: Record<Role, string> = {
  owner: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  admin: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  member: "bg-panel-3 text-muted",
};

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`rounded-md px-1.5 py-px font-mono text-[10px] uppercase tracking-wider ${ROLE_STYLE[role]}`}>{role}</span>;
}

/** Green when it checked in lately; otherwise when it last did. */
export function OnlineDot({ online, lastSeenAt, now }: { online: boolean; lastSeenAt: number; now: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted" title={new Date(lastSeenAt).toLocaleString()}>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-faint"}`} aria-hidden />
      {online ? "online" : `seen ${formatAgo(now - lastSeenAt)}`}
    </span>
  );
}

const STATUS: Record<RunStatus, { label: string; tone: string }> = {
  queued: { label: "queued", tone: "" },
  running: { label: "running", tone: "chip-warn" },
  done: { label: "done", tone: "chip-good" },
  failed: { label: "failed", tone: "chip-bad" },
  cancelled: { label: "cancelled", tone: "" },
};

export function StatusChip({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <span className={`chip ${s.tone}`}>
      {(status === "running" || status === "queued") && <span className="live h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {s.label}
    </span>
  );
}

/** A titled panel. */
export function Card({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-panel ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-medium text-fg-2">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** What an empty list says instead. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-muted">{children}</p>;
}
