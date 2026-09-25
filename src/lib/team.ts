import type { DeviceActivity, Tool } from "./activity";
import { requestJson } from "./api";
import type { CliProfile, HelloRun, HelloSchedule, ScheduleMode } from "./local";
import type { Account, Provider, Usage } from "./types";

/*
 * Teams: people, the computers they connected, every Claude Code and Codex
 * session on those computers, the limits of their linked accounts, and
 * sessions started on a computer from the dashboard. Owners and admins see all
 * of it for the team's members, and of each other what each shares (see
 * SharePolicy); members see the roster and their own. Everyone has a personal
 * workspace, "me", with just their own.
 */

export type Role = "owner" | "admin" | "member";

export const TOOL_NAME: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };

/** What remote sessions may do on a computer. Set on that computer only; the server never changes it. */
export type RemoteLevel = "off" | "read" | "edit" | "full";

export const REMOTE_LEVELS: RemoteLevel[] = ["off", "read", "edit", "full"];

export const REMOTE_LABEL: Record<RemoteLevel, string> = { off: "Off", read: "Read only", edit: "Edit files", full: "Full access" };

export const REMOTE_HELP: Record<RemoteLevel, string> = {
  off: "No one can start Claude Code or Codex sessions here from the dashboard.",
  read: "Sessions can read the project and answer or plan, but change nothing: Claude Code in plan mode, Codex in its read-only sandbox.",
  edit: "Sessions can also edit files in the project. Claude Code runs no commands; Codex runs commands inside its sandbox, without network.",
  full: "Sessions can edit anything and run any command, without asking. Only for a computer you would hand to Claude Code or Codex unattended.",
};

/** Whether a computer at `level` runs a session asking for `mode`. */
export function levelAllows(level: RemoteLevel, mode: RemoteLevel): boolean {
  return mode !== "off" && REMOTE_LEVELS.includes(mode) && REMOTE_LEVELS.indexOf(mode) <= REMOTE_LEVELS.indexOf(level);
}

/**
 * Whether what a computer's sessions say (their titles, and conversations on
 * request) leaves it: "off" keeps it there, "on" lets the website have it for
 * whoever sees those sessions: the computer's owner, and the owners and admins
 * of their teams as SharePolicy has it. Set on the computer, except that a
 * member's is on: their teams' owners and admins see all of their work.
 * Before 0.7 a computer said "me" or "team" (or, before 0.6, true) for on.
 */
export type ShareLevel = "off" | "on";

export const SHARE_LEVELS: ShareLevel[] = ["off", "on"];

export const SHARE_LABEL: Record<ShareLevel, string> = { off: "Private", on: "On the website" };

export const SHARE_HELP: Record<ShareLevel, string> = {
  off: "Sessions show on the Team page without titles, and their conversations stay on this computer: nobody reads them on the website, you included.",
  on: "You see session titles and can read and continue any conversation from the website. Your teams' owners and admins see the projects and chats you share with them.",
};

/**
 * What a team's owner or admin shows the other owners and admins of their
 * teams: everything, or the projects (by folder name, on all their computers)
 * and single chats they pick, and nothing until they pick. A member shows
 * everything: their teams' owners and admins manage them.
 */
export type SharePolicy = { all: boolean; projects: string[]; sessions: string[] };

export const SHARE_NOTHING: SharePolicy = { all: false, projects: [], sessions: [] };

/** A session among all of them, as SharePolicy and the Sessions tab name it: its computer, CLI and id. */
export const sessionKey = (deviceId: string, tool: Tool, id: string) => `${deviceId}:${tool}:${id}`;

export const projectShared = (policy: SharePolicy, name: string) => policy.all || policy.projects.includes(name);

/** A session is shared by itself, or with its project. */
export const sessionShared = (policy: SharePolicy, key: string, project: string) => projectShared(policy, project) || policy.sessions.includes(key);

/** A project's name, as the Projects tab and SharePolicy know it: its folder's. */
export function projectName(activity: DeviceActivity | null, tool: Tool, path: string): string {
  return activity?.projects.find((p) => p.tool === tool && p.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** How much of someone's work their team's owners and admins see: all of it as a member's, all of it by choice, or what they pick. */
export type Sharing = "managed" | "all" | "picked";

/** What a computer hears at each check-in about who else sees what of it. */
export type DeviceSharing = {
  /** The teams its owner is a member of: their owners and admins see everything here, what sessions say included. */
  managedBy: string[];
  /** What its owner shows the other owners and admins of the teams they run: all of it, or these projects, and these sessions here ("tool:id"). */
  all: boolean;
  projects: string[];
  sessions: string[];
};

/** Whether a CLI can run remote sessions on a computer: installed and signed in, installed but signed out, or not there. */
export type ToolState = "ready" | "signed-out" | "missing";

/** The AI Cooldown version a computer needs to continue its own sessions and take remote commands. */
export const CHAT_VERSION = "0.6.0";

/** The version that knows what its owner shares, so their teams' owners and admins may continue its own sessions. */
export const SHARING_VERSION = "0.7.0";

/** Whether version `v` (x.y.z) is `min` or later. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Claude Code's model aliases, offered next to the models a computer has used. */
export const CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];

/** A model a remote session may ask for: an alias or a model id, nothing a shell would read. */
export const MODEL_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

/** The longest prompt a remote session takes. */
export const MAX_PROMPT = 20_000;

/** Claude Code's session ids and Codex's thread ids: what continuing a session resumes, and what names a transcript. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceInfo = {
  /** The computer's host name. */
  name: string;
  os: string;
  platform: string;
  arch: string;
  /** The AI Cooldown version it runs. */
  version: string;
  /** Whose account each CLI on the computer is signed in with, by email; null when signed out. */
  logins: Record<Provider, string | null>;
  remote: RemoteLevel;
  /** Whether what its sessions say reaches the website: titles, and transcripts on request. */
  share: ShareLevel;
  /** Whether each CLI can run remote sessions there. */
  tools: Record<Tool, ToolState>;
};

/**
 * The CLI logins saved on a computer and its scheduled hellos, for its owner
 * to manage from the website: which login each CLI uses, and when a 5-hour
 * window starts. Emails and times only, never credentials.
 */
export type DeviceManage = { profiles: CliProfile[]; schedules: HelloSchedule[]; hellos: Record<string, HelloRun> };

/** What the owner can have their computer do from the website. */
export type CommandKind = "switch" | "save" | "hello" | "schedule" | "cancel";

export type NewCommand =
  | { kind: "switch" | "hello"; profileId: string }
  | { kind: "save"; provider: Provider }
  | { kind: "schedule"; profileId: string; mode: ScheduleMode; at?: number }
  | { kind: "cancel"; scheduleId: string };

/** A command for one computer, as the website shows it: what it was, and how it went once the computer did it. */
export type Command = { id: string; kind: CommandKind; label: string; status: "queued" | "running" | "done" | "failed"; message: string | null; createdAt: number; finishedAt: number | null };

export type Device = DeviceInfo & {
  id: string;
  userId: string;
  /** The name it goes by: its owner's for it, or else its host name. */
  name: string;
  /** Its host name, as the computer reports it. */
  hostname: string;
  /** The name its owner gave it, if any. */
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
  /** False after its link was revoked (its owner signed out other devices); it comes back when they sign in there again. */
  connected: boolean;
  activity: DeviceActivity | null;
  /** Its saved logins and scheduled hellos: only for its owner. */
  manage: DeviceManage | null;
  /** The latest commands its owner sent it, newest first: only for its owner. */
  commands: Command[];
};

/** A linked Claude or Codex account, without its tokens, and the last usage its owner's dashboard read. */
export type MemberAccount = Omit<Account, "accessToken" | "refreshToken"> & { userId: string; usage: Usage | null };

export type Member = {
  id: string;
  email: string;
  /** null in the personal workspace. */
  role: Role | null;
  joinedAt: number | null;
  /** Whether their computers, accounts and activity are included: your own, or everyone's for owners and admins. */
  detailed: boolean;
  /** How much of their work the team's owners and admins see; null in the personal workspace. */
  sharing: Sharing | null;
  devices: Device[];
  accounts: MemberAccount[];
};

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type RunResult = { costUsd?: number; turns?: number; durationMs?: number; error?: string };

export type Run = {
  id: string;
  tool: Tool;
  deviceId: string;
  deviceName: string;
  /** Who started it, by email; null for an account deleted since. */
  by: string | null;
  project: string;
  prompt: string;
  mode: RemoteLevel;
  model: string | null;
  /** The session it continues, if any. */
  resume: string | null;
  status: RunStatus;
  /** The CLI's session id, once it started: continuing the run resumes it. */
  sessionId: string | null;
  result: RunResult | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

/** A session as the computer receives it to run. */
export type RunJob = { id: string; tool: Tool; project: string; prompt: string; mode: RemoteLevel; model: string | null; resume: string | null; by: string | null };

export type RunEventKind = "user" | "text" | "tool" | "output" | "error" | "info" | "result" | "image";

/** One step of a conversation. An "image" step's text is an ImageRef, as JSON: the picture itself comes on request. */
export type RunEvent = { seq: number; at: number; kind: RunEventKind; text: string };

/** The kinds of picture a session's images may be: what a browser shows safely, never SVG. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** The largest image a computer sends; a bigger one says how big it is instead. */
export const MAX_IMAGE_BYTES = 2_000_000;

/** An image in a session's log: which one it is there (from 0, in the order the log has them), its kind and size, and whether it was pasted with a prompt or came from a tool. */
export type ImageRef = { n: number; type: ImageType; bytes: number; by: "user" | "tool" };

export function parseImageRef(text: string): ImageRef | null {
  try {
    const v = JSON.parse(text) as Partial<ImageRef>;
    const ok = Number.isInteger(v.n) && v.n! >= 0 && IMAGE_TYPES.includes(v.type as ImageType) && typeof v.bytes === "number" && (v.by === "user" || v.by === "tool");
    return ok ? (v as ImageRef) : null;
  } catch {
    return null;
  }
}

/** Where an image of a session stands: not asked for (or no longer kept), asked for, here, or not to be had. */
export type ImageState = { n: number; status: "none" | "pending" | "ready" | "failed"; error: string | null };

export const RUN_FINISHED: RunStatus[] = ["done", "failed", "cancelled"];

/** A session's conversation as its computer read it from the CLI's log, fetched when someone asks for it. */
export type Transcript = {
  status: "pending" | "ready" | "failed";
  events: RunEvent[];
  error: string | null;
  requestedAt: number;
  updatedAt: number;
};

export type Invite = { id: string; email: string | null; role: Role; createdAt: number; expiresAt: number; by: string | null };

export type TeamSummary = { id: string; name: string; role: Role; members: number };

export type Workspace = {
  team: { id: string; name: string } | null;
  role: Role | null;
  me: { id: string; email: string };
  members: Member[];
  invites: Invite[];
  runs: Run[];
  /** What you share with the other owners and admins of the teams you run. */
  sharing: SharePolicy;
  /** The server's clock, to judge "seen 2 minutes ago" without trusting the browser's. */
  now: number;
};

export type InvitePreview = { team: string; role: Role; email: string | null; by: string | null; expiresAt: number };

export type NewRun = { deviceId: string; tool: Tool; project: string; prompt: string; mode: RemoteLevel; model: string | null; resume: string | null };

/** Owners and admins manage the team and see everyone's details. */
export const manages = (role: Role | null) => role === "owner" || role === "admin";

/** Whether the viewer may start sessions on this computer at all: their own, or anyone's in a team they manage. */
export const mayRunOn = (ws: Workspace, device: Device) => device.userId === ws.me.id || manages(ws.role);

/** Why a session cannot start on this computer right now (with `tool`, when given), or null when it can. */
export function unavailable(device: Device, tool?: Tool): string | null {
  if (!device.connected) return "disconnected";
  if (!device.online) return "offline";
  if (device.remote === "off") return "remote sessions off";
  if (tool && device.tools[tool] === "missing") return `${TOOL_NAME[tool]} is not installed there`;
  if (tool && device.tools[tool] === "signed-out") return `${TOOL_NAME[tool]} is not signed in there`;
  return null;
}

/**
 * Why the viewer cannot send a message into this conversation on this
 * computer, or null when they can: a conversation a remote session started,
 * or any of the computer's sessions the viewer sees, for its owner, and for
 * its owner's team admins when it lets what sessions say reach the website.
 */
export function chatBlocked(ws: Workspace, device: Device, tool: Tool, startedHere: boolean): string | null {
  if (!mayRunOn(ws, device)) return "Only its owner and the admins of their teams start sessions there.";
  const why = unavailable(device, tool);
  if (why) return `${device.name}: ${why}.`;
  if (startedHere) return null;
  if (!versionAtLeast(device.version, CHAT_VERSION)) return `Update AI Cooldown on ${device.name} to ${CHAT_VERSION} or later to continue its own sessions from here.`;
  if (device.userId === ws.me.id) return null;
  if (device.share === "off") return `${device.name} keeps what its sessions say to itself, so only its owner continues them from here.`;
  if (!versionAtLeast(device.version, SHARING_VERSION)) return `Update AI Cooldown on ${device.name} to ${SHARING_VERSION} or later to continue its sessions from here.`;
  return null;
}

export const fetchTeams = () => requestJson<{ teams: TeamSummary[] }>("/api/teams");
export const fetchWorkspace = (scope: string) => requestJson<Workspace>(`/api/teams/${encodeURIComponent(scope)}`);
export const createTeam = (name: string) => requestJson<{ team: TeamSummary }>("/api/teams", { method: "POST", body: { name } });
export const renameTeam = (id: string, name: string) => requestJson(`/api/teams/${id}`, { method: "PATCH", body: { name } });
export const deleteTeam = (id: string) => requestJson(`/api/teams/${id}`, { method: "DELETE", body: {} });
export const setRole = (teamId: string, userId: string, role: Role) => requestJson(`/api/teams/${teamId}/members`, { method: "PATCH", body: { userId, role } });
export const removeMember = (teamId: string, userId: string) => requestJson(`/api/teams/${teamId}/members`, { method: "DELETE", body: { userId } });
export const createInvite = (teamId: string, email: string | null, role: Role) =>
  requestJson<{ invite: Invite; url: string }>(`/api/teams/${teamId}/invites`, { method: "POST", body: { email, role } });
export const revokeInvite = (teamId: string, inviteId: string) => requestJson(`/api/teams/${teamId}/invites`, { method: "DELETE", body: { inviteId } });
export const previewInvite = (token: string) => requestJson<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`);
export const acceptInvite = (token: string) => requestJson<{ teamId: string }>(`/api/invites/${encodeURIComponent(token)}`, { method: "POST", body: {} });
export const removeDevice = (deviceId: string) => requestJson("/api/devices", { method: "DELETE", body: { deviceId } });
/** Names one of your computers ("Work laptop"); an empty name goes back to its host name. */
export const renameDevice = (deviceId: string, label: string) => requestJson("/api/devices", { method: "PATCH", body: { deviceId, label } });
/** Shares everything or what you pick, or shares or stops sharing a project (by name) or one session (by sessionKey). */
export type SharingChange = { all: boolean } | { project: string; shared: boolean } | { session: string; shared: boolean };
export const changeSharing = (change: SharingChange) => requestJson<{ sharing: SharePolicy }>("/api/sharing", { method: "POST", body: change });
export const startRun = (run: NewRun) => requestJson<{ run: Run }>("/api/runs", { method: "POST", body: run });
export const fetchRun = (id: string, after: number) => requestJson<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}?after=${after}`);
export const cancelRun = (id: string) => requestJson(`/api/runs/${id}`, { method: "DELETE", body: {} });
/** Asks one of your computers to do something with its CLI logins or hellos. */
export const sendCommand = (deviceId: string, command: NewCommand) => requestJson<{ command: Command }>("/api/devices/commands", { method: "POST", body: { deviceId, ...command } });
/** Someone is working with this computer: it checks in every few seconds for a while. */
export const heatDevice = (deviceId: string) => requestJson("/api/devices/heat", { method: "POST", body: { deviceId } });
/** Asks the session's computer for its transcript; `refresh` asks again for one already fetched. */
export const requestTranscript = (deviceId: string, tool: Tool, sessionId: string, refresh: boolean) =>
  requestJson<Transcript>("/api/sessions", { method: "POST", body: { deviceId, tool, sessionId, refresh } });
/** Asks the session's computer for some of its images (by ImageRef.n); says where each stands. */
export const requestImages = (deviceId: string, tool: Tool, sessionId: string, n: number[], retry = false) =>
  requestJson<{ images: ImageState[] }>("/api/sessions/images", { method: "POST", body: { deviceId, tool, sessionId, n, retry } });
/** Where these images stand, without asking for any. */
export const fetchImageStates = (deviceId: string, tool: Tool, sessionId: string, n: number[]) =>
  requestJson<{ images: ImageState[] }>(`/api/sessions/images?${new URLSearchParams({ deviceId, tool, sessionId, n: n.join(",") })}`);
/** An image the computer sent, to show as it is. */
export const imageUrl = (deviceId: string, tool: Tool, sessionId: string, n: number) => `/api/sessions/image?${new URLSearchParams({ deviceId, tool, sessionId, n: String(n) })}`;
export const fetchTranscript = (deviceId: string, tool: Tool, sessionId: string) =>
  requestJson<Transcript | null>(`/api/sessions?${new URLSearchParams({ deviceId, tool, sessionId })}`);
