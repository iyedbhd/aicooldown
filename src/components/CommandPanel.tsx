import { formatCountdown } from "@/lib/format";
import { providerVerdict, type Ranked } from "@/lib/stats";
import type { Provider } from "@/lib/types";
import { Icon } from "./Icon";
import { PROVIDER_META, ProviderGlyph } from "./ProviderLogo";

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

const TINT = {
  go: "from-emerald-500/12 to-transparent",
  tight: "from-amber-500/12 to-transparent",
  wait: "from-rose-500/12 to-transparent",
  unknown: "from-transparent to-transparent",
} as const;

/**
 * The answer to "which account do I use right now?", one card per provider:
 * a large Go / Wait verdict on a tinted background, then the accounts ranked
 * by headroom.
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
        const tone = { go: "text-emerald-600 dark:text-emerald-300", tight: "text-amber-600 dark:text-amber-300", wait: "text-rose-600 dark:text-rose-300", unknown: "text-muted" }[state];
        return (
          <section key={provider} className={`fade-in overflow-hidden rounded-2xl border border-line bg-panel bg-gradient-to-br ${TINT[state]}`}>
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
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`text-3xl font-semibold tracking-tight ${tone}`}>
                  {verdict.kind === "go" ? (state === "tight" ? "Go, carefully" : "Go") : verdict.kind === "wait" ? `Wait ${formatCountdown(verdict.waitMs)}` : "Waiting for data"}
                </span>
                <span className="min-w-0 text-sm text-muted">
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
                </span>
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
