import { postJson, type ApiResult } from "./api";
import type { Tool } from "./activity";
import type { DeviceSharing, RemoteLevel, RunStatus, ShareLevel, ToolState } from "./team";
import type { Provider } from "./types";

/**
 * "This machine" features, only served by a copy running on the user's own
 * computer: switching which login the Claude Code / Codex CLI uses, and
 * sending a "hello" through the CLI to start a 5-hour session window now or
 * on a schedule.
 */

/** A CLI login saved on this machine. */
export type CliProfile = {
  id: string;
  provider: Provider;
  label: string;
  plan?: string;
  /** True when this is the login the CLI currently uses. */
  active: boolean;
  savedAt: number;
};

export type ScheduleMode = "at" | "reset" | "every-reset";

export type HelloSchedule = {
  id: string;
  profileId: string;
  mode: ScheduleMode;
  /** Epoch ms of the next send. */
  at: number;
  createdAt: number;
};

export type HelloRun = { at: number; ok: boolean; message: string; scheduled: boolean };

/** The login a CLI uses right now: null when it has none, `error` when there is one but whose it is can't be told. */
export type LiveLogin = { label: string; saved: boolean } | { error: string } | null;

/** A remote session this computer ran, as it keeps a note of it. */
export type LocalRun = {
  id: string;
  tool: Tool;
  project: string;
  prompt: string;
  by: string | null;
  mode: RemoteLevel;
  status: RunStatus;
  at: number;
  sessionId: string | null;
  /** It continued a conversation rather than starting one. */
  resumed?: boolean;
};

/** This computer as a device of an AI Cooldown account (server/local/device.ts). */
export type LocalDevice = {
  /** The account it reports to, while connected. */
  linked: { server: string; email: string } | null;
  /** Who connected it last: it reconnects by itself when they sign in here again. */
  owner: { userId: string; email: string } | null;
  /** What remote sessions may do here. Only ever set on this computer. */
  remote: RemoteLevel;
  /** Whether what its sessions say (titles, and transcripts on request) reaches the website: its owner's choice, set here only. */
  share: ShareLevel;
  /** Who else sees what of it, as the server said at the latest check-in; null before one. A member's teams see everything, whatever `share` says. */
  sharing: DeviceSharing | null;
  lastSync: number | null;
  error: string | null;
  running: LocalRun | null;
  /** The latest remote sessions here, newest first. */
  recent: LocalRun[];
};

export type LocalState = {
  live: Record<Provider, LiveLogin>;
  profiles: CliProfile[];
  schedules: HelloSchedule[];
  /** Last hello per profile id. */
  runs: Record<string, HelloRun>;
  /** Where signing in keeps accounts, e.g. "aicooldown.com"; null for this copy's own database. */
  accountsServer: string | null;
  /** Whether each CLI can run remote sessions here, and what to run in a terminal to sign it in. */
  tools: Record<Provider, { state: ToolState; signIn: string }>;
  device: LocalDevice;
};

export type LocalAction =
  | { action: "save"; provider: Provider }
  | { action: "switch" | "forget" | "hello"; profileId: string }
  | { action: "schedule"; profileId: string; mode: ScheduleMode; at?: number }
  | { action: "cancel"; scheduleId: string }
  | { action: "connect" }
  /** `forget` also forgets who connected it, so it does not reconnect when they sign in again. */
  | { action: "disconnect"; forget: boolean }
  | { action: "remote"; level: RemoteLevel }
  | { action: "share"; level: ShareLevel }
  | { action: "stop-run" };

/** null when this copy is not running locally (the route answers 404). */
export async function fetchLocalState(): Promise<LocalState | null> {
  try {
    const res = await fetch("/api/local", { cache: "no-store" });
    return res.ok ? ((await res.json()) as LocalState) : null;
  } catch {
    return null;
  }
}

export function localAction(body: LocalAction): Promise<ApiResult<LocalState>> {
  return postJson<LocalState>("/api/local", body);
}
