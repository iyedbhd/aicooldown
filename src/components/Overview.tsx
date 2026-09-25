"use client";

import { formatCountdown, formatMoney } from "@/lib/format";
import { spendSummary } from "@/lib/spend";
import type { ResetEvent } from "@/lib/stats";
import type { Account, Usage } from "@/lib/types";
import { useAnimatedNumber } from "@/lib/use-animated-number";
import { ProviderGlyph } from "./ProviderLogo";

type Props = { accounts: Account[]; usages: Record<string, Usage | undefined>; resets: ResetEvent[]; now: number };

/** Three numbers worth knowing before anything else: what it costs, how much of this week's money is used, and the next reset. */
export function Overview({ accounts, usages, resets, now }: Props) {
  const spend = spendSummary(accounts, usages);
  // Whole dollars everywhere here: this is a feel for the money, not an invoice.
  const monthly = Math.round(useAnimatedNumber(spend.monthly));
  const weekUsed = Math.round(useAnimatedNumber(spend.week?.used ?? 0));
  const next = resets[0];
  const weekPct = spend.week ? (spend.week.used / spend.week.total) * 100 : 0;
  const unused = spend.week ? Math.round(spend.week.total - spend.week.used) : 0;
  const weekNote =
    !spend.week ? null : weekPct >= 95 ? "every dollar earned its keep" : weekPct >= 70 ? `${formatMoney(unused)} left to burn` : `${formatMoney(unused)} unused so far, no rush`;

  return (
    <div className="fade-in grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
      <Tile label="you pay" title="List prices of the plans your accounts report">
        <Big>{spend.monthly > 0 || spend.unpriced.length === 0 ? `${formatMoney(monthly)}/mo` : "—"}</Big>
        <Note>
          {spend.monthly > 0 && <>{formatMoney(Math.round(spend.perDay))} a day · </>}
          {accounts.length} subscription{accounts.length === 1 ? "" : "s"}
          {spend.unpriced.length > 0 && <> · {spend.unpriced.length} unpriced</>}
        </Note>
      </Tile>

      <Tile label="this week" title="Your weekly limits, priced: how much of this week's money you have used">
        {spend.week ? (
          <>
            <Big>
              {formatMoney(weekUsed)} <span className="text-base font-normal text-muted">of {formatMoney(Math.round(spend.week.total))}</span>
            </Big>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-track">
              <div className="h-full rounded-full bg-fg transition-[width] duration-700" style={{ width: `${Math.min(100, weekPct)}%` }} />
            </div>
            <Note>{weekNote}</Note>
          </>
        ) : (
          <>
            <Big>—</Big>
            <Note>needs a priced plan and a weekly window</Note>
          </>
        )}
      </Tile>

      <Tile label="next reset" title="The soonest reset across every account">
        {next ? (
          <>
            <Big>{formatCountdown(next.at - now)}</Big>
            <Note>
              <span className="inline-flex items-center gap-1.5">
                <ProviderGlyph provider={next.account.provider} size={11} className="opacity-90" />
                <span className="truncate">
                  {next.account.label} · {next.window.label}
                </span>
              </span>
            </Note>
          </>
        ) : (
          <>
            <Big>—</Big>
            <Note>no reset times yet</Note>
          </>
        )}
      </Tile>
    </div>
  );
}

export function Tile({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-panel px-5 py-4" title={title}>
      <p className="eyebrow">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function Big({ children }: { children: React.ReactNode }) {
  return <div className="truncate font-mono text-2xl font-semibold tabular-nums text-fg">{children}</div>;
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 truncate font-mono text-[11px] text-muted">{children}</p>;
}
