export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatDateTime(iso: string, now: number): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAgo(ms: number): string {
  const text = formatCountdown(ms);
  return text === "now" ? "just now" : `${text} ago`;
}

/** "$340", "$11.20": whole dollars unless the cents matter. */
export function formatMoney(usd: number): string {
  const rounded = Math.round(usd * 100) / 100;
  return Number.isInteger(rounded) || rounded >= 100 ? `$${Math.round(rounded)}` : `$${rounded.toFixed(2)}`;
}

/** "self_serve_business_prolite" → "Business Pro Lite", "plus" → "Plus". */
export function formatPlan(plan: string | null | undefined): string | null {
  if (!plan) return null;
  return plan
    .replace(/^self_serve_/, "")
    .replace(/prolite/i, "pro lite")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
