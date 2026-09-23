import { postJson, type ApiResult } from "./api";
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

export type LocalState = {
  /** The login each CLI uses right now, if it has one. */
  live: Record<Provider, { label: string; saved: boolean } | null>;
  profiles: CliProfile[];
  schedules: HelloSchedule[];
  /** Last hello per profile id. */
  runs: Record<string, HelloRun>;
  /** Where signing in keeps accounts, e.g. "aicooldown.com"; null for this copy's own database. */
  accountsServer: string | null;
};

export type LocalAction =
  | { action: "save"; provider: Provider }
  | { action: "switch" | "forget" | "hello"; profileId: string }
  | { action: "schedule"; profileId: string; mode: ScheduleMode; at?: number }
  | { action: "cancel"; scheduleId: string };

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
