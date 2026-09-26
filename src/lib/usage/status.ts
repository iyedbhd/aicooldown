import type { DesktopStatus } from "@/lib/desktop";
import { formatCountdown } from "@/lib/format";
import { providerVerdict, rankAccounts, verdictState } from "@/lib/stats";
import type { Snapshot } from "./engine";

const NAME = { claude: "Claude", codex: "Codex" } as const;
/** From calm to alarming: the tray shows the most alarming provider. */
const SEVERITY: DesktopStatus["level"][] = ["none", "unknown", "go", "tight", "wait"];
/** Windows cuts tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127;

/** Minutes are enough for the tray, so it changes about once a minute: "42m", "1h 23m", "2d 7h". */
function coarse(ms: number): string {
  return ms < 3600_000 ? `${Math.max(1, Math.ceil(ms / 60_000))}m` : formatCountdown(ms);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The desktop app's tray and taskbar status: one line per provider, and the worst verdict as the colour. */
export function desktopStatus(s: Snapshot, now: number): DesktopStatus {
  const usages = Object.fromEntries(s.accounts.map((a) => [a.id, s.states[a.id]?.usage]));
  const ranked = rankAccounts(s.accounts, usages);
  let level: DesktopStatus["level"] = "none";
  const lines: string[] = [];
  for (const provider of ["claude", "codex"] as const) {
    if (ranked[provider].length === 0) continue;
    const verdict = providerVerdict(ranked[provider], now);
    const { state, headroom } = verdictState(verdict);
    if (SEVERITY.indexOf(state) > SEVERITY.indexOf(level)) level = state;
    const name = NAME[provider];
    if (verdict.kind === "go") lines.push(clip(`${name}: ${state === "tight" ? "Go, carefully" : "Go"} · ${verdict.account.label} · ${Math.round(headroom ?? 0)}% left`, 60));
    else if (verdict.kind === "wait") lines.push(clip(`${name}: Wait ${coarse(verdict.waitMs)} · ${verdict.account.label} is back first`, 60));
    else lines.push(`${name}: waiting for data`);
  }
  return { level, lines, tooltip: clip(["AI Cooldown", ...lines].join("\n"), TOOLTIP_MAX), notify: s.notify };
}
