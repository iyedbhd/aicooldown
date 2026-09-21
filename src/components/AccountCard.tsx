"use client";

import { useState } from "react";
import { formatAgo, formatCountdown, formatMoney, formatPlan } from "@/lib/format";
import { monthlyPrice } from "@/lib/spend";
import type { Sample } from "@/lib/history";
import type { Account } from "@/lib/types";
import type { UsageState } from "@/lib/usage-client";
import { Icon } from "./Icon";
import { PROVIDER_META, ProviderTile } from "./ProviderLogo";
import { WindowRow } from "./WindowRow";

function tokenStatus(account: Account, now: number, synced: boolean): { text: string; warn: boolean } {
  const where = synced ? "synced" : "this browser";
  if (account.owned) return { text: `signed in · auto-refresh · ${where}`, warn: false };
  if (account.expiresAt === undefined) return { text: `imported token · ${where}`, warn: false };
  const left = account.expiresAt - now;
  if (left <= 0) return { text: "imported token · expired", warn: true };
  return { text: `imported token · expires in ${formatCountdown(left)}`, warn: left < 60 * 60_000 };
}

type Props = {
  account: Account;
  state: UsageState | undefined;
  history: Record<string, Sample[]> | undefined;
  now: number;
  synced: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onRename: (label: string) => void;
};

export function AccountCard({ account, state, history, now, synced, onRefresh, onRemove, onRename }: Props) {
  const meta = PROVIDER_META[account.provider];
  const usage = state?.usage;
  const loading = !state || state.status === "loading";
  const token = tokenStatus(account, now, synced);
  const plan = formatPlan(account.plan ?? usage?.plan);
  const price = monthlyPrice(account.provider, account.plan ?? usage?.plan);
  const rateLimited = state?.rateLimitedUntil !== undefined && state.rateLimitedUntil > now;
  const [draft, setDraft] = useState<string | null>(null);

  function commitRename() {
    const next = draft?.trim();
    if (next && next !== account.label) onRename(next);
    setDraft(null);
  }

  return (
    <section className="fade-in flex flex-col rounded-2xl border border-line bg-panel shadow-sm transition-shadow hover:shadow-md">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <ProviderTile provider={account.provider} size={40} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>{meta.name}</span>
            {plan && (
              <>
                <span className="text-faint">·</span>
                <span className="rounded-md bg-panel-3 px-1.5 py-px font-medium text-fg-2">{plan}</span>
                {price !== null && (
                  <span className="font-mono text-[11px] text-faint" title="List price of this plan">
                    {price === 0 ? "free" : `${formatMoney(price)}/mo`}
                  </span>
                )}
              </>
            )}
          </div>
          {draft === null ? (
            <button type="button" onClick={() => setDraft(account.label)} className="group mt-0.5 flex max-w-full items-center gap-1.5 text-left" title="Rename">
              <span className="truncate text-base font-semibold text-fg">{account.label}</span>
              <span className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
                edit
              </span>
            </button>
          ) : (
            <input
              autoFocus
              value={draft}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setDraft(null);
              }}
              aria-label="Account name"
              className="mt-0.5 w-full border-b border-muted bg-transparent text-base font-semibold text-fg focus:outline-none"
            />
          )}
          <p className={`mt-0.5 font-mono text-[11px] ${token.warn ? "text-amber-600 dark:text-amber-300" : "text-faint"}`}>{token.text}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={onRefresh} disabled={loading} className="rounded-lg p-1.5 text-muted transition hover:bg-panel-3 hover:text-fg disabled:opacity-40" aria-label="Refresh usage" title="Refresh">
            <Icon name="refresh" size={15} className={loading ? "spin" : undefined} />
          </button>
          <button type="button" onClick={onRemove} className="rounded-lg p-1.5 text-muted transition hover:bg-rose-500/15 hover:text-rose-500" aria-label="Remove account" title="Remove">
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <div className="divide-y divide-line px-4">
        {usage?.windows.map((w) => (
          <WindowRow key={w.key} window={w} samples={history?.[w.key] ?? []} now={now} accent={meta.accent} />
        ))}
        {usage && usage.windows.length === 0 && <p className="py-3 text-sm text-muted">No usage windows reported.</p>}
        {!usage && loading && (
          <div className="space-y-3 py-4" aria-label="Loading usage">
            <div className="shimmer h-4 w-1/3 rounded" />
            <div className="shimmer h-2 w-full rounded-full" />
            <div className="shimmer h-4 w-1/2 rounded" />
            <div className="shimmer h-2 w-full rounded-full" />
          </div>
        )}
      </div>

      {(usage?.models?.length || usage?.notes?.length || rateLimited || state?.status === "error") && (
        <div className="space-y-2 border-t border-line px-4 py-3">
          {usage?.models && usage.models.length > 0 && (
            <ul className="space-y-1 font-mono text-[11px]">
              {usage.models.map((m) => {
                const availableMs = m.availableAt ? new Date(m.availableAt).getTime() - now : null;
                return (
                  <li key={m.name} className="flex justify-between gap-2">
                    <span className="truncate text-muted">{m.name}</span>
                    <span className={m.available ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300"}>
                      {m.available ? "available" : availableMs !== null && availableMs > 0 ? `back in ${formatCountdown(availableMs)}` : "unavailable"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {usage?.notes?.map((note) => (
            <p key={note} className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-100/90">
              {note}
            </p>
          ))}
          {rateLimited && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-100/90">
              {meta.vendor} is rate-limiting this token.{" "}
              {usage ? `Showing data from ${formatAgo(now - new Date(usage.fetchedAt).getTime())}.` : "No data yet."} Next try in{" "}
              {formatCountdown(state!.rateLimitedUntil! - now)}.
            </p>
          )}
          {state?.status === "error" && !rateLimited && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{state.error}</p>}
        </div>
      )}

      {usage && (
        <footer className="flex items-center justify-between border-t border-line px-4 py-2 font-mono text-[10px] tabular-nums text-faint">
          <span>data from {formatAgo(now - new Date(usage.fetchedAt).getTime())}</span>
          {state?.nextPollAt && state.nextPollAt > now && !rateLimited && <span>next poll {formatCountdown(state.nextPollAt - now)}</span>}
        </footer>
      )}
    </section>
  );
}
