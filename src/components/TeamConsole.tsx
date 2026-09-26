"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCommands } from "@/lib/commands";
import { useDesktop } from "@/lib/desktop";
import { fetchSession, onSessionChange, type SessionUser } from "@/lib/session";
import {
  changeSharing,
  createTeam,
  deleteTeam,
  fetchTeams,
  fetchWorkspace,
  manages,
  mayRunOn,
  removeMember,
  renameTeam,
  type SharingChange,
  type TeamSummary,
  type Workspace,
} from "@/lib/team";
import { allSessions, liveNow, PERIODS, type Period } from "@/lib/team-stats";
import { confirmAction, toast } from "@/lib/ui";
import { AuthDialog } from "./AuthDialog";
import { ChatPanel, type ChatTarget } from "./ChatPanel";
import { Icon } from "./Icon";
import { Mark, Wordmark } from "./Logo";
import { RefreshButton, useRefresh } from "./RefreshButton";
import { TeamAnalytics } from "./TeamAnalytics";
import { RoleBadge } from "./TeamBits";
import { TeamComputers } from "./TeamComputers";
import { TeamOverview } from "./TeamOverview";
import { TeamPeople } from "./TeamPeople";
import { TeamProjects } from "./TeamProjects";
import { NO_FILTER, TeamSessions, type SessionFilter } from "./TeamSessions";
import { ThemeToggle } from "./ThemeToggle";

type Tab = "overview" | "analytics" | "people" | "computers" | "projects" | "sessions";

const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "analytics", label: "Analytics", icon: "trend" },
  { id: "people", label: "People", icon: "users" },
  { id: "computers", label: "Computers", icon: "monitor" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "sessions", label: "Sessions", icon: "terminal" },
];

const POLL_MS = 30_000;
/** The workspace last looked at, per browser. */
const SCOPE_KEY = "aic:team-scope";

const input = "rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";

function storedScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY);
  } catch {
    return null;
  }
}

/**
 * What the team's owners and admins see of your work: all of it, as a member,
 * or, as an owner or admin, everything or the projects and chats you pick.
 */
function SharingLine({ ws, onShare }: { ws: Workspace; onShare: (change: SharingChange) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (!ws.team || !ws.role) return null;
  if (ws.role === "member") {
    return (
      <p className="mt-2 flex max-w-3xl items-start gap-1.5 text-xs text-muted">
        <Icon name="eye" size={12} className="mt-0.5 shrink-0" />
        As a member, the team&apos;s owner and admins see all your work on the computers you connect: every project and session, what your sessions say included, and
        they can continue those sessions where you allow remote sessions. Share projects with other members on the Projects tab, and chats from their header.
      </p>
    );
  }
  const { all, projects, sessions } = ws.shares;
  async function choose(everything: boolean) {
    if (everything === all) return;
    if (
      everything &&
      !(await confirmAction({
        title: "Show the other owners and admins all of your work?",
        body: "They then see every project and session on your computers, what those sessions say where your computers let that reach the website, and can continue those sessions where you allow remote sessions.",
        confirmLabel: "Show everything",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    await onShare({ all: everything });
    setBusy(false);
  }
  const [np, ns] = [Object.keys(projects).length, Object.keys(sessions).length];
  const picked = [np && `${np} project${np === 1 ? "" : "s"}`, ns && `${ns} chat${ns === 1 ? "" : "s"}`].filter(Boolean);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="flex items-start gap-1.5">
        <Icon name={all ? "eye" : "lock"} size={12} className="mt-0.5 shrink-0" />
        What the team&apos;s other owners and admins see of your work:
      </span>
      <div role="radiogroup" aria-label="What you share" className="inline-flex gap-0.5 rounded-lg border border-line bg-panel p-0.5">
        {[false, true].map((everything) => (
          <button
            key={String(everything)}
            type="button"
            role="radio"
            aria-checked={all === everything}
            disabled={busy}
            onClick={() => void choose(everything)}
            className={`rounded-md px-2 py-0.5 transition ${all === everything ? "bg-panel-3 text-fg" : "text-muted hover:text-fg-2"}`}
          >
            {everything ? "Everything" : "What you pick"}
          </button>
        ))}
      </div>
      {!all && <span className="text-faint">{picked.length ? `${picked.join(" and ")} shared` : "nothing yet: share projects on the Projects tab, and chats from their header"}</span>}
    </div>
  );
}

/**
 * The team page: a workspace (just you, or one of your teams) with its
 * people, their computers and projects, what they use, and remote sessions.
 */
export function TeamConsole() {
  /** undefined until known. */
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  /** When the workspace on screen was read. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<Period>(7);
  const [now, setNow] = useState(() => Date.now());
  /** The conversation open in the chat. */
  const [chat, setChat] = useState<ChatTarget | null>(null);
  const [filter, setFilter] = useState<SessionFilter>(NO_FILTER);
  /** Whom the Analytics tab is about: "all", or a person's id. */
  const [analyticsPerson, setAnalyticsPerson] = useState("all");
  const [showAuth, setShowAuth] = useState(false);
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);

  const flash = useCallback((text: string) => {
    toast(text);
  }, []);

  const refreshTeams = useCallback(async () => {
    const res = await fetchTeams();
    if (res.ok) setTeams(res.data.teams);
    return res.ok ? res.data.teams : [];
  }, []);

  /** Shows another workspace; the effect below loads it. */
  const choose = useCallback((next: string) => {
    if (scopeRef.current !== next) {
      setWs(null);
      setLoadedAt(null);
      setFilter(NO_FILTER);
      setAnalyticsPerson("all");
      setChat(null);
    }
    scopeRef.current = next;
    setScope(next);
    setError(null);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* remembering it is a nicety */
    }
    const url = new URL(window.location.href);
    if (next === "me") url.searchParams.delete("team");
    else url.searchParams.set("team", next);
    window.history.replaceState(null, "", url);
  }, []);

  const loadWorkspace = useCallback(async () => {
    const target = scopeRef.current;
    if (!target) return;
    const res = await fetchWorkspace(target);
    if (scopeRef.current !== target) return; // switched meanwhile
    if (res.ok) {
      setWs(res.data);
      setLoadedAt(Date.now());
      setError(null);
    } else if (res.code === "signed_out") {
      setUser(null);
    } else if (res.status === 404 && target !== "me") {
      await refreshTeams();
      choose("me");
      flash("You are no longer in that team.");
    } else {
      setError(res.error);
    }
  }, [choose, flash, refreshTeams]);

  /** Signed in (or not): their teams, and the workspace the address or this browser last showed. */
  const begin = useCallback(
    async (u: SessionUser | null) => {
      setUser(u);
      if (!u) return;
      const list = await refreshTeams();
      const params = new URLSearchParams(window.location.search);
      const wantedTab = TABS.find((t) => t.id === params.get("tab"));
      if (wantedTab) setTab(wantedTab.id);
      const wanted = params.get("team") ?? storedScope();
      choose(wanted && (wanted === "me" || list.some((t) => t.id === wanted)) ? wanted : (list[0]?.id ?? "me"));
    },
    [choose, refreshTeams],
  );

  useEffect(() => {
    void fetchSession().then(begin);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Signed in or out elsewhere (the command palette, the dashboard in another page of the app).
    const off = onSessionChange(() => void fetchSession().then(begin));
    return () => {
      clearInterval(tick);
      off();
    };
  }, [begin]);

  useEffect(() => {
    if (!scope) return;
    void loadWorkspace();
    const poll = setInterval(() => document.visibilityState === "visible" && void loadWorkspace(), POLL_MS);
    return () => clearInterval(poll);
  }, [scope, loadWorkspace]);

  const reload = useCallback(async () => {
    await Promise.all([loadWorkspace(), refreshTeams()]);
  }, [loadWorkspace, refreshTeams]);
  /** Asked for: the button, Ctrl+R, the palette. A failure shows in the page's own message. */
  const [refreshing, refresh] = useRefresh(reload);

  /** Shares or stops sharing some of your work with the other owners and admins of your teams. */
  const share = useCallback(
    async (change: SharingChange) => {
      const res = await changeSharing(change);
      if (!res.ok) return flash(res.error);
      setWs((w) => (w ? { ...w, shares: res.data.shares, sharing: res.data.sharing } : w));
      await loadWorkspace();
    },
    [flash, loadWorkspace],
  );

  async function submitTeam(e: React.FormEvent) {
    e.preventDefault();
    const res = await createTeam(teamName);
    if (!res.ok) return flash(res.error);
    setCreating(false);
    setTeamName("");
    await refreshTeams();
    choose(res.data.team.id);
    setTab("people");
    flash(`${res.data.team.name} is ready. Invite the people you work with.`);
  }

  async function saveName() {
    const name = renaming?.trim();
    setRenaming(null);
    if (!ws?.team || !name || name === ws.team.name) return;
    const res = await renameTeam(ws.team.id, name);
    if (!res.ok) return flash(res.error);
    await reload();
  }

  async function leaveOrDelete() {
    if (!ws?.team) return;
    const owner = ws.role === "owner";
    const question = owner
      ? "Its members keep their accounts, computers and sessions; only the team goes."
      : "Its owner and admins stop seeing your computers, usage and limits.";
    if (!(await confirmAction({ title: owner ? `Delete ${ws.team.name}?` : `Leave ${ws.team.name}?`, body: question, confirmLabel: owner ? "Delete the team" : "Leave", danger: true }))) return;
    const res = owner ? await deleteTeam(ws.team.id) : await removeMember(ws.team.id, ws.me.id);
    if (!res.ok) return flash(res.error);
    await refreshTeams();
    choose("me");
    flash(owner ? "Team deleted." : "You left the team.");
  }

  /** The Sessions tab, showing a person's, a computer's or a project's sessions. */
  function showSessions(only: Partial<SessionFilter> = {}) {
    setFilter({ ...NO_FILTER, ...only });
    setTab("sessions");
  }

  /** The Analytics tab, about one person. */
  function showAnalytics(person: string) {
    setAnalyticsPerson(person);
    setTab("analytics");
  }

  const openRun = (id: string) => setChat({ kind: "run", id });
  const openSession = (key: string) => setChat({ kind: "session", key });
  const newChat = (deviceId?: string) => setChat({ kind: "new", deviceId });

  const devices = ws?.members.flatMap((m) => m.devices) ?? [];
  const sessions = ws ? allSessions(ws, now) : [];
  const live = ws ? liveNow(ws, sessions) : null;
  const liveCount = live ? live.sessions.length + live.runs.length : 0;
  const canChat = Boolean(ws && devices.some((d) => mayRunOn(ws, d)));
  const desktop = useDesktop();

  useCommands("team", () => [
    ...(user ? [{ id: "refresh", title: "Refresh the team", group: "Team", icon: "refresh" as const, shortcut: desktop ? "Ctrl+R" : undefined, keywords: "reload", run: () => void refresh() }] : []),
    ...(ws
      ? TABS.map((t) => ({ id: `team-tab:${t.id}`, title: `Team: ${t.label}`, group: "Team", icon: t.icon, keywords: "tab section", run: () => setTab(t.id) }))
      : []),
    ...(canChat ? [{ id: "new-chat", title: "New chat on a computer", group: "Team", icon: "terminal" as const, keywords: "claude codex session run", run: () => newChat() }] : []),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="border-b border-line pb-4 titlebar:hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <Link href="/" className="flex items-center gap-3">
            <Mark size={40} animated />
            <div>
              <div className="text-2xl leading-none">
                <Wordmark />
              </div>
              <p className="eyebrow mt-1.5">teams · computers · sessions</p>
            </div>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {user && <span className="mr-1 max-w-[16rem] truncate font-mono text-[11px] text-muted">{user.email}</span>}
            <ThemeToggle className="btn" />
            <Link href="/" className="btn">
              <Icon name="gauge" />
              Limits
            </Link>
          </div>
        </div>
      </header>

      {user === null && (
        <section className="fade-in mx-auto mt-12 max-w-xl rounded-2xl border border-dashed border-line p-10 text-center">
          <Icon name="users" size={30} className="mx-auto text-faint" />
          <h1 className="mt-3 text-lg font-medium text-fg">Your team&apos;s AI work in one place</h1>
          <p className="mt-2 text-sm text-muted">
            Invite the people you work with and see each one&apos;s connected computers, every Claude Code and Codex session on them and the projects they work
            on, the tokens those use and what that is worth, how close their accounts are to their limits, and start Claude Code or Codex sessions on a computer
            from here. Teams need an account.
          </p>
          <button type="button" onClick={() => setShowAuth(true)} className="btn btn-primary mt-6">
            <Icon name="user" />
            Sign in or create an account
          </button>
        </section>
      )}

      {user && (
        <>
          <nav className="mt-4 flex flex-wrap items-center gap-2" aria-label="Workspaces">
            {[{ id: "me", name: "Just me" }, ...teams].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => choose(t.id)}
                aria-pressed={scope === t.id}
                className={`btn ${scope === t.id ? "btn-accent" : ""}`}
              >
                <Icon name={t.id === "me" ? "user" : "users"} />
                {t.name}
              </button>
            ))}
            {creating ? (
              <form onSubmit={submitTeam} className="flex items-center gap-2">
                <input autoFocus required maxLength={60} value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" aria-label="Team name" className={input} />
                <button type="submit" className="btn btn-primary">
                  Create
                </button>
                <button type="button" onClick={() => setCreating(false)} className="btn">
                  Cancel
                </button>
              </form>
            ) : (
              <button type="button" onClick={() => setCreating(true)} className="btn">
                <Icon name="plus" />
                New team
              </button>
            )}
          </nav>

          <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {ws?.team ? (
                <>
                  <p className="eyebrow flex items-center gap-2">
                    team {ws.role && <RoleBadge role={ws.role} />}
                  </p>
                  {renaming !== null ? (
                    <input
                      autoFocus
                      value={renaming}
                      maxLength={60}
                      onChange={(e) => setRenaming(e.target.value)}
                      onBlur={() => void saveName()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveName();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      aria-label="Team name"
                      className="mt-1 w-full border-b border-muted bg-transparent text-2xl font-semibold text-fg focus:outline-none"
                    />
                  ) : (
                    <h1 className="mt-1 text-2xl font-semibold text-fg">
                      {manages(ws.role) ? (
                        <button type="button" onClick={() => setRenaming(ws.team!.name)} className="group flex items-center gap-2 text-left" title="Rename">
                          {ws.team.name}
                          <span className="text-[11px] font-normal text-faint opacity-0 transition-opacity group-hover:opacity-100">edit</span>
                        </button>
                      ) : (
                        ws.team.name
                      )}
                    </h1>
                  )}
                  <p className="mt-1 text-sm text-muted">
                    {ws.members.length} {ws.members.length === 1 ? "person" : "people"}
                    {manages(ws.role) ? ` · ${devices.length} computer${devices.length === 1 ? "" : "s"}, ${devices.filter((d) => d.online).length} online` : ""}
                  </p>
                  <SharingLine ws={ws} onShare={share} />
                </>
              ) : (
                <>
                  <p className="eyebrow">personal</p>
                  <h1 className="mt-1 text-2xl font-semibold text-fg">Just you</h1>
                  <p className="mt-1 text-sm text-muted">
                    Your connected computers, their Claude Code and Codex sessions, and what they work on. Create a team to see the same for the people you work with.
                  </p>
                </>
              )}
            </div>
            {ws?.team && (
              <button type="button" onClick={() => void leaveOrDelete()} className="btn border-rose-500/40 text-rose-600 dark:text-rose-400">
                <Icon name={ws.role === "owner" ? "trash" : "logout"} />
                {ws.role === "owner" ? "Delete team" : "Leave team"}
              </button>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-b border-line">
            <div role="tablist" aria-label="Sections" className="-mb-px flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${tab === t.id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg-2"}`}
                >
                  <Icon name={t.icon} size={13} />
                  {t.label}
                  {t.id === "sessions" && liveCount > 0 && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300" title="live now">
                      {liveCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {ws && (
                <RefreshButton
                  label={ws.team ? "Refresh the team" : "Refresh"}
                  busy={refreshing}
                  onRefresh={() => void refresh()}
                  updatedAt={loadedAt}
                  now={now}
                  showAge
                  shortcut={desktop ? "Ctrl+R" : undefined}
                />
              )}
              {canChat && (
                <button type="button" onClick={() => newChat()} className="btn btn-primary">
                  <Icon name="terminal" />
                  New chat
                </button>
              )}
            {tab !== "sessions" && (
              <div role="group" aria-label="Period" className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5">
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={period === p}
                    onClick={() => setPeriod(p)}
                    className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition ${period === p ? "bg-panel-3 text-fg" : "text-muted hover:text-fg-2"}`}
                  >
                    {p} days
                  </button>
                ))}
              </div>
            )}
            </div>
          </div>

          <div className="mt-5">
            {error && (
              <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
                <span className="min-w-0">
                  {ws ? "Couldn't refresh" : "Couldn't load"}: {error}
                </span>
                <RefreshButton text="Try again" label="Try again" busy={refreshing} onRefresh={() => void refresh()} />
              </div>
            )}
            {!ws && !error && (
              <div className="space-y-3" aria-label="Loading">
                <div className="shimmer h-24 rounded-2xl" />
                <div className="shimmer h-48 rounded-2xl" />
              </div>
            )}
            {ws && tab === "overview" && (
              <TeamOverview
                ws={ws}
                sessions={sessions}
                period={period}
                now={now}
                onOpenRun={openRun}
                onOpenSession={openSession}
                onShowSessions={() => showSessions()}
                onShowComputers={() => setTab("computers")}
              />
            )}
            {ws && tab === "analytics" && (
              <TeamAnalytics
                ws={ws}
                period={period}
                now={now}
                person={analyticsPerson}
                onPerson={setAnalyticsPerson}
                onShowSessions={showSessions}
                onShowComputers={() => setTab("computers")}
              />
            )}
            {ws && tab === "people" && (
              <TeamPeople
                ws={ws}
                sessions={sessions}
                period={period}
                now={now}
                reload={reload}
                flash={flash}
                onOpenSession={openSession}
                onShowSessions={showSessions}
                onShowAnalytics={showAnalytics}
              />
            )}
            {ws && tab === "computers" && (
              <TeamComputers ws={ws} sessions={sessions} period={period} now={now} reload={reload} flash={flash} onNewChat={newChat} onShowSessions={showSessions} />
            )}
            {ws && tab === "projects" && (
              <TeamProjects ws={ws} sessions={sessions} period={period} now={now} onShowSessions={showSessions} onOpenSession={openSession} onShare={share} />
            )}
            {ws && tab === "sessions" && (
              <TeamSessions
                ws={ws}
                sessions={sessions}
                now={now}
                filter={filter}
                onFilter={setFilter}
                onNewChat={canChat ? () => newChat() : undefined}
                onOpenRun={openRun}
                onOpenSession={openSession}
              />
            )}
          </div>
        </>
      )}

      {chat && ws && (
        <ChatPanel
          key={chat.kind === "new" ? `new:${chat.deviceId ?? ""}` : chat.kind === "run" ? chat.id : chat.key}
          ws={ws}
          sessions={sessions}
          now={now}
          target={chat}
          onClose={() => setChat(null)}
          onChanged={() => void loadWorkspace()}
          onShare={share}
        />
      )}
      {showAuth && (
        <AuthDialog
          localCount={0}
          onClose={() => setShowAuth(false)}
          // Signing in is announced: the session listener above loads the teams.
          onSignedIn={() => setShowAuth(false)}
        />
      )}
    </main>
  );
}
