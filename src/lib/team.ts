import type { DeviceActivity, Tool } from "./activity";
import { requestJson } from "./api";
import type { Account, Provider, Usage } from "./types";

/*
 * Teams: people, the computers they connected, every Claude Code and Codex
 * session on those computers, the limits of their linked accounts, and
 * sessions started on a computer from the dashboard. Owners and admins see all
 * of it for everyone in the team; members see the roster and their own.
 * Everyone has a personal workspace, "me", with just their own.
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
  /** Whether it shares what its sessions say: titles, and transcripts on request. Set on that computer only. */
  share: boolean;
};

export type Device = DeviceInfo & {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
  /** False after its link was revoked (its owner signed out other devices); it comes back when they sign in there again. */
  connected: boolean;
  activity: DeviceActivity | null;
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

export type RunEventKind = "user" | "text" | "tool" | "output" | "error" | "info" | "result";

export type RunEvent = { seq: number; at: number; kind: RunEventKind; text: string };

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
  /** The server's clock, to judge "seen 2 minutes ago" without trusting the browser's. */
  now: number;
};

export type InvitePreview = { team: string; role: Role; email: string | null; by: string | null; expiresAt: number };

export type NewRun = { deviceId: string; tool: Tool; project: string; prompt: string; mode: RemoteLevel; model: string | null; resume: string | null };

/** Owners and admins manage the team and see everyone's details. */
export const manages = (role: Role | null) => role === "owner" || role === "admin";

/** Whether the viewer may start sessions on this computer at all: their own, or anyone's in a team they manage. */
export const mayRunOn = (ws: Workspace, device: Device) => device.userId === ws.me.id || manages(ws.role);

/** Why a session cannot start on this computer right now, or null when it can. */
export function unavailable(device: Device): string | null {
  if (!device.connected) return "disconnected";
  if (!device.online) return "offline";
  if (device.remote === "off") return "remote sessions off";
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
export const startRun = (run: NewRun) => requestJson<{ run: Run }>("/api/runs", { method: "POST", body: run });
export const fetchRun = (id: string, after: number) => requestJson<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}?after=${after}`);
export const cancelRun = (id: string) => requestJson(`/api/runs/${id}`, { method: "DELETE", body: {} });
/** Asks the session's computer for its transcript; `refresh` asks again for one already fetched. */
export const requestTranscript = (deviceId: string, tool: Tool, sessionId: string, refresh: boolean) =>
  requestJson<Transcript>("/api/sessions", { method: "POST", body: { deviceId, tool, sessionId, refresh } });
export const fetchTranscript = (deviceId: string, tool: Tool, sessionId: string) =>
  requestJson<Transcript | null>(`/api/sessions?${new URLSearchParams({ deviceId, tool, sessionId })}`);
