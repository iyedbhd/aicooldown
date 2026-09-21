import { formatCountdown } from "@/lib/format";
import { providerVerdict, type Ranked } from "@/lib/stats";
import type { Provider } from "@/lib/types";
import { Icon } from "./Icon";
import { PROVIDER_META, ProviderGlyph } from "./ProviderLogo";
import { Ring } from "./Ring";

type Props = { ranked: Record<Provider, Ranked[]>; now: number };

function Meter({ value, accent, label }: { value: number | null; accent: string; label: string }) {
  if (value === null) return <span className="font-mono text-[11px] text-faint">—</span>;
  return (
    <div className="flex items-center gap-2" title={`${Math.round(value)}% ${label} left`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: accent }} />
      </div>
      <span className="w-9 text-right font-mono text-[11px] tabular-nums text-fg-2">{Math.round(value)}%</span>
    </div>
  );
}

const STATE = {
  go: { tint: "from-emerald-500/12 to-transparent", text: "text-emerald-600 dark:text-emerald-300", ring: "#10b981" },
  tight: { tint: "from-amber-500/12 to-transparent", text: "text-amber-600 dark:text-amber-300", ring: "#f59e0b" },
  wait: { tint: "from-rose-500/12 to-transparent", text: "text-rose-600 dark:text-rose-300", ring: "#f43f5e" },
  unknown: { tint: "from-transparent to-transparent", text: "text-muted", ring: "transparent" },
} as const;

/**
 * The answer to "which account do I use right now?", one card per provider:
 * a ring gauge (headroom when you can go, progress through the wait when you
 * cannot), a large Go / Wait verdict, then the accounts ranked by headroom.
 */
export function CommandPanel({ ranked, now }: Props) {
  const providers = (Object.keys(ranked) as Provider[]).filter((p) => ranked[p].length > 0);
  return (
    <div className={`grid gap-4 ${providers.length > 1 ? "md:grid-cols-2" : ""}`}>
      {providers.map((provider) => {
        const meta = PROVIDER_META[provider];
        const list = ranked[provider];
        const verdict = providerVerdict(list, now);
        const headroom = verdict.kind === "go" ? Math.min(verdict.sessionLeft ?? 100, verdict.weeklyLeft ?? 100) : null;
        const state = verdict.kind === "wait" ? "wait" : verdict.kind === "unknown" ? "unknown" : headroom !== null && headroom < 20 ? "tight" : "go";
        const s = STATE[state];
        // Wait: how far through the wait we are. Go: headroom on the account to use.
        const ringValue =
          verdict.kind === "wait" ? (verdict.windowMs ? Math.max(0, Math.min(100, (1 - verdict.waitMs / verdict.windowMs) * 100)) : 0) : (headroom ?? 0);
        return (
          <section key={provider} className={`fade-in overflow-hidden rounded-2xl border border-line bg-panel bg-gradient-to-br ${s.tint}`}>
            <div className="px-5 pt-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-fg-2">
                  <ProviderGlyph provider={provider} size={16} />
                  {meta.product}
                </span>
                <span className="text-xs text-faint">
                  {list.length} account{list.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-4">
                <Ring
                  value={ringValue}
                  color={s.ring}
                  label={verdict.kind === "wait" ? `${Math.round(ringValue)}% of the wait is over` : `${Math.round(ringValue)}% headroom`}
                >
                  {verdict.kind === "unknown" ? (
                    <span className="font-mono text-sm text-faint">…</span>
                  ) : (
                    <>
                      <span className={`font-mono text-lg font-semibold tabular-nums ${s.text}`}>{Math.round(ringValue)}%</span>
                      <span className="mt-0.5 text-[9px] uppercase tracking-wider text-faint">{verdict.kind === "wait" ? "waited" : "room"}</span>
                    </>
                  )}
                </Ring>
                <div className="min-w-0">
                  <div className={`text-3xl font-semibold tracking-tight ${s.text}`}>
                    {verdict.kind === "go" ? (state === "tight" ? "Go, carefully" : "Go") : verdict.kind === "wait" ? `Wait ${formatCountdown(verdict.waitMs)}` : "Waiting for data"}
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {verdict.kind === "go" && (
                      <>
                        use <span className="font-medium text-fg">{verdict.account.label}</span>
                        {verdict.sessionLeft !== null && <> · {Math.round(verdict.sessionLeft)}% session</>}
                        {verdict.weeklyLeft !== null && <> · {Math.round(verdict.weeklyLeft)}% weekly</>}
                      </>
                    )}
                    {verdict.kind === "wait" && (
                      <>
                        every account is out · <span className="font-medium text-fg">{verdict.account.label}</span> is back first
                      </>
                    )}
                    {verdict.kind === "unknown" && "first poll is on its way"}
                  </div>
                </div>
              </div>
            </div>

            <ul className="mt-4 divide-y divide-line border-t border-line">
              {list.map((r) => {
                const isBest = verdict.kind === "go" && r.account.id === verdict.account.id;
                return (
                  <li key={r.account.id} className={`flex items-center gap-3 px-5 py-2.5 ${isBest ? "text-fg" : "text-muted"}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 truncate text-sm">
                        {isBest && <Icon name="check" size={12} className="shrink-0 text-emerald-500" />}
                        <span className="truncate">{r.account.label}</span>
                      </div>
                      {r.blockedUntil && <div className="font-mono text-[10px] text-rose-600 dark:text-rose-300">back in {formatCountdown(r.blockedUntil - now)}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-faint">session</span>
                        <Meter value={r.sessionLeft} accent={meta.accent} label="session" />
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-faint">weekly</span>
                        <Meter value={r.weeklyLeft} accent={meta.accent} label="weekly" />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
