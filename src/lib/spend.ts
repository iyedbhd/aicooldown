import { isSessionWindow } from "./stats";
import type { Account, Provider, Usage } from "./types";

/*
 * What the subscriptions cost, from the plan label each provider reports.
 * List prices in USD per month; team seats vary, so those are the common
 * per-seat price. Unknown plans are reported, not guessed.
 */
const PRICES: Record<Provider, [RegExp, number][]> = {
  claude: [
    [/max.*20x/i, 200],
    [/max/i, 100],
    [/team|enterprise/i, 30],
    [/pro/i, 20],
    [/free/i, 0],
  ],
  codex: [
    [/team|business|enterprise/i, 30],
    [/pro/i, 200],
    [/plus/i, 20],
    [/\bgo\b/i, 5],
    [/free/i, 0],
  ],
};

export function monthlyPrice(provider: Provider, plan: string | null | undefined): number | null {
  if (!plan) return null;
  const hit = PRICES[provider].find(([re]) => re.test(plan));
  return hit ? hit[1] : null;
}

export type Spend = {
  /** Sum of known subscription prices, USD per month. */
  monthly: number;
  perDay: number;
  /** Accounts whose plan has no known price. */
  unpriced: Account[];
  /** Cost-weighted share of this week's capacity already used, across priced accounts with a weekly window. */
  week: { used: number; total: number } | null;
};

const WEEKS_PER_MONTH = 52 / 12;

export function spendSummary(accounts: Account[], usages: Record<string, Usage | undefined>): Spend {
  let monthly = 0;
  let weekUsed = 0;
  let weekTotal = 0;
  const unpriced: Account[] = [];
  for (const account of accounts) {
    const usage = usages[account.id];
    const price = monthlyPrice(account.provider, account.plan ?? usage?.plan);
    if (price === null) {
      unpriced.push(account);
      continue;
    }
    monthly += price;
    const weekly = usage?.windows.filter((w) => !isSessionWindow(w)) ?? [];
    if (weekly.length === 0) continue;
    // The broadest weekly window decides how much of the money has been used.
    const used = Math.max(...weekly.map((w) => w.usedPercent));
    const weekPrice = price / WEEKS_PER_MONTH;
    weekTotal += weekPrice;
    weekUsed += (weekPrice * used) / 100;
  }
  return {
    monthly,
    perDay: (monthly * 12) / 365,
    unpriced,
    week: weekTotal > 0 ? { used: weekUsed, total: weekTotal } : null,
  };
}
