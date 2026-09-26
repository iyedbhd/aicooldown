import { postJson, requestJson, type ApiResult } from "./api";

/*
 * The Claude app's chats (its Code tab's sessions) on this computer, one list
 * per account, and copying or moving them between accounts. Only a copy of AI
 * Cooldown running on the user's computer answers (server/local/claude-app.ts);
 * elsewhere the API is a 404 and the feature does not show.
 */

/** Where the Claude app keeps a list of chats: an account, and the organization it used there. */
export type ChatPlace = { account: string; org: string };

export type ClaudeAppChat = {
  /** The app's own id, "local_<uuid>". */
  id: string;
  title: string;
  /** The project folder it works in. */
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  archived: boolean;
  model: string | null;
  turns: number | null;
  /** Size of its conversation on disk; null when that is missing, so it cannot be copied. */
  bytes: number | null;
  /** Worked in within the last minutes while the Claude app is open: it can be copied, not moved. */
  inUse: boolean;
  /** Places it was copied to from here, and the place it was copied from, as AI Cooldown recorded them. */
  copiedTo: ChatPlace[];
  copiedFrom: ChatPlace | null;
};

export type ClaudeAppPlace = ChatPlace & {
  /** Who it is: the name given here, else the account's email when known, else null. */
  label: string | null;
  email: string | null;
  orgName: string | null;
  /** The account the Claude app is signed in with now. */
  current: boolean;
  /** Where the app keeps this account's new chats, so where copies go. */
  home: boolean;
  chats: ClaudeAppChat[];
};

export type ChatOperation = {
  id: string;
  kind: "copy" | "move";
  at: number;
  from: ChatPlace;
  to: ChatPlace;
  items: { title: string; source: string; copy: string }[];
  /** Undone, with how many copies were kept because they were used since. */
  undone: { at: number; kept: number } | null;
};

export type ClaudeAppState = {
  /** The Claude app's data folder was found on this computer. */
  found: boolean;
  /** The Claude app is open: it shows copies after switching to that account or reopening, and may write back a chat moved away while open. */
  running: boolean;
  places: ClaudeAppPlace[];
  /** Recent copies and moves, newest first. */
  history: ChatOperation[];
};

export type ChatsResult = { done: number; skipped: { title: string; reason: string }[]; operation: string | null; kept?: number };

export type ClaudeChatsAction =
  | { action: "copy" | "move"; from: ChatPlace; to: ChatPlace; chats: string[] }
  | { action: "undo"; operation: string }
  | { action: "name"; account: string; name: string | null };

export const samePlace = (a: ChatPlace, b: ChatPlace) => a.account === b.account && a.org === b.org;

/** Who a place is, for people: its name, else "Account 6f6412ff". */
export const placeName = (p: Pick<ClaudeAppPlace, "label" | "account">) => p.label ?? `Account ${p.account.slice(0, 8)}`;

/** null when this copy does not run on the user's computer (the route answers 404). */
export async function fetchClaudeChats(): Promise<ClaudeAppState | null> {
  const res = await requestJson<ClaudeAppState>("/api/local/claude-chats");
  return res.ok ? res.data : null;
}

export function claudeChatsAction(body: ClaudeChatsAction): Promise<ApiResult<{ state: ClaudeAppState; result: ChatsResult | null }>> {
  return postJson("/api/local/claude-chats", body);
}
