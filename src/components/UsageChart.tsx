"use client";

import { formatTokens, type Tool } from "@/lib/activity";
import { formatMoney } from "@/lib/format";
import { TOOL_NAME } from "@/lib/team";
import type { DayPoint } from "@/lib/team-stats";
import { ColumnChart } from "./ColumnChart";

/*
 * Tokens per day, Claude Code stacked under Codex. The two hues are the
 * providers' accents (Claude's one step deeper), checked as a pair against
 * both themes' panels for lightness, colour-blind separation and contrast.
 */
const COLOR: Record<Tool, string> = { claude: "#d27252", codex: "#10a37f" };
const TOOLS: Tool[] = ["claude", "codex"];

export function UsageChart({ points }: { points: DayPoint[] }) {
  return (
    <ColumnChart
      days={points.map((p) => p.day)}
      series={TOOLS.map((t) => ({ key: t, label: TOOL_NAME[t], color: COLOR[t], values: points.map((p) => p[t]) }))}
      format={formatTokens}
      describe={(total) => `${formatTokens(total)} tokens`}
      note={(i) => (points[i].cost > 0 ? `≈ ${formatMoney(points[i].cost)} at API prices` : null)}
      label="Tokens per day"
      empty="No tokens in this period yet."
    />
  );
}
