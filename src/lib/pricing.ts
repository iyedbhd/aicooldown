import type { TokenRow } from "./activity";

/*
 * What Claude Code's and Codex's tokens would cost on the API, from the list
 * prices in USD per million tokens (standard tier). Subscriptions do not bill
 * per token; this is what the work is worth. Models without a known price are
 * reported as unpriced, not guessed.
 */
type Price = { input: number; output: number; cacheRead: number; cacheWrite?: number };

/**
 * Anthropic, most specific first: the first pattern the model id matches
 * prices it. Cache writes cost 1.25x the input price for the 5-minute cache
 * and 2x for the hour-long one.
 */
const ANTHROPIC: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/3-5-haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/haiku/, { input: 0.25, output: 1.25, cacheRead: 0.03 }],
];

/** OpenAI, by model id. Cache writes cost the input price unless the model lists its own. The -codex models cost what their base model does. */
const OPENAI: Record<string, Price> = {
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheRead: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.1": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cacheRead: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cacheRead: 0.005, output: 0.4 },
};

/** USD for one row, or null when the model has no known price. */
export function costOf(row: Pick<TokenRow, "model" | "input" | "output" | "cacheWrite" | "cacheWrite1h" | "cacheRead">): number | null {
  if (row.model.startsWith("claude-")) {
    const p = ANTHROPIC.find(([re]) => re.test(row.model))?.[1];
    if (!p) return null;
    const fiveMinute = row.cacheWrite - row.cacheWrite1h;
    return (row.input * p.input + row.output * p.output + fiveMinute * p.input * 1.25 + row.cacheWrite1h * p.input * 2 + row.cacheRead * p.cacheRead) / 1e6;
  }
  // Dated snapshots cost what their model does.
  const p = OPENAI[row.model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!p) return null;
  return (row.input * p.input + row.output * p.output + row.cacheWrite * (p.cacheWrite ?? p.input) + row.cacheRead * p.cacheRead) / 1e6;
}
