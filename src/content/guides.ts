/*
 * Search-facing guides. Each answers one question people type into Google
 * about Claude and Codex limits, in plain HTML that crawlers can read, and
 * ends by pointing at the dashboard for the exact numbers.
 */

export type Section = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: { head: string[]; rows: string[][] };
};

export type Guide = {
  slug: string;
  /** <title>, under ~60 characters. */
  title: string;
  /** Meta description, under ~155 characters. */
  description: string;
  h1: string;
  /** The direct answer, shown first. Two or three sentences. */
  answer: string;
  updated: string;
  sections: Section[];
  faq: { q: string; a: string }[];
  related: string[];
};

const UPDATED = "2026-09-21";

export const GUIDES: Guide[] = [
  {
    slug: "claude-code-usage-limit",
    title: "Claude Code usage limits explained (session, weekly, per model)",
    description:
      "What the Claude Code usage limits are on Pro and Max: the 5-hour session window, the weekly window, and the per-model weekly limits for Fable, Opus and Sonnet.",
    h1: "Claude Code usage limits, explained",
    answer:
      "Claude Code on Pro and Max has three kinds of limits: a 5-hour session window that starts with your first message, a weekly window across all models, and separate weekly windows for specific models such as Fable, Opus and Sonnet. Each one is a percentage with its own reset clock, and whichever hits 100% first is the one that stops you.",
    updated: UPDATED,
    sections: [
      {
        heading: "The three windows",
        bullets: [
          "Session (5 hours). Opens with the first message you send and closes five hours later. Everything you do in Claude Code and on claude.ai in that time counts against it. When it fills up you wait for the reset; when it resets you get the whole window back.",
          "Weekly, all models. A rolling seven-day window that covers everything you send, whichever model handles it. It was added on top of the session window so that very heavy users cannot run flat out around the clock.",
          "Weekly, per model. Some models get their own seven-day window on top of the shared one. Fable is the clearest case: a heavy Fable session can exhaust the Fable window while the all-models window still has plenty left, and you can keep working on Sonnet.",
        ],
      },
      {
        heading: "What counts against them",
        paragraphs: [
          "Every request counts, weighted by how much work it is. Long conversations cost more than short ones because the whole context is re-read on each turn. Large files, big diffs and tool-heavy agent loops burn faster than a quick question. Bigger models burn the shared windows faster than smaller ones, and the per-model windows only move when that model is used.",
          "Anthropic does not publish the limits as token counts, and they change with demand. What it does publish, through the same usage endpoint the Claude Code CLI reads, is a percentage used for each window and the moment each one resets. That is the number to plan around.",
        ],
      },
      {
        heading: "Why it feels random",
        paragraphs: [
          "The windows are rolling, not tied to the clock. Your session window started whenever you first spoke to Claude today, so its reset lands at an odd time like 3:47 PM. Your weekly window started days ago, on whatever day you first used Claude that week, so it does not reset on Monday. And because three windows run at once, the message that stops you could be any of them.",
          "The fix is to look at all three at the same time, with their reset times, instead of guessing from the one warning message Claude shows you.",
        ],
      },
      {
        heading: "Where to see where you stand",
        bullets: [
          "In Claude Code, the /usage command shows the current windows and their resets.",
          "On claude.ai, Settings shows usage for the account you are signed into.",
          "AI Cooldown shows every window for every Claude and Codex account you connect on one page, with a live countdown to each reset and a plain Go or Wait verdict. It reads the same official usage endpoint the CLI uses, so the percentages are Anthropic's, not estimates.",
        ],
      },
      {
        heading: "What to do when you hit a limit",
        bullets: [
          "Check which window it is. A per-model limit means switching model, not stopping.",
          "If you have a second account, check whether it has room before you wait. Limits are per account.",
          "If the session window is the problem, the reset is at most five hours away and usually much less. The weekly windows are the ones worth pacing: divide what is left by the days until the reset and you have a daily budget.",
          "Start the day's session window with a small message when you sit down, so the five-hour clock is already running before you do heavy work.",
        ],
      },
    ],
    faq: [
      {
        q: "Does Claude Code share limits with claude.ai?",
        a: "Yes. The session and weekly windows belong to the account, and Claude Code, the desktop app and claude.ai all draw from the same ones.",
      },
      {
        q: "Are the limits the same on Pro and Max?",
        a: "No. Max plans come with roughly five or twenty times the Pro allowance in each window, which is why they are labelled Max 5x and Max 20x. The windows and reset rules are the same.",
      },
      {
        q: "Does the weekly limit reset every Monday?",
        a: "No. It is a rolling seven-day window that resets seven days after it started, at whatever time that was.",
      },
      {
        q: "Can I buy more usage when I hit a limit?",
        a: "Anthropic has offered paid extra usage on some plans. Check the usage settings for your account; if it is available, it appears there when a window is exhausted.",
      },
    ],
    related: ["claude-code-limit-reset", "claude-weekly-limit", "claude-code-usage-tracker"],
  },
  {
    slug: "claude-code-limit-reset",
    title: "When does the Claude Code limit reset?",
    description:
      "The Claude Code session limit resets 5 hours after the first message that started it, not at a fixed time. Weekly limits reset 7 days after they started. Here is how to see the exact moment.",
    h1: "When does the Claude Code limit reset?",
    answer:
      "The session limit resets exactly five hours after the first message that opened the window, not at a fixed time of day. The weekly limits reset seven days after their own window opened. Anthropic reports the exact reset time for each window, and AI Cooldown shows it as a live countdown for every account you connect.",
    updated: UPDATED,
    sections: [
      {
        heading: "The session reset rule",
        paragraphs: [
          "Think of the five-hour window as a timer that starts when you send your first message and does not care what you do after that. Send one message at 9:12 AM and the window runs until 2:12 PM whether you use Claude heavily or not at all. When it ends, the counter drops to zero and the next message you send starts a fresh five-hour window.",
          "There is no partial recovery inside a window. Usage does not trickle back as time passes; you get all of it back at once when the window closes.",
        ],
      },
      {
        heading: "A worked example",
        bullets: [
          "9:12 AM, first message. Session window A opens, reset at 2:12 PM.",
          "1:50 PM, the window hits 100%. Claude tells you to come back later.",
          "2:12 PM, window A closes. Everything is back.",
          "2:30 PM, next message. Window B opens, reset at 7:30 PM.",
        ],
      },
      {
        heading: "The weekly reset rule",
        paragraphs: [
          "The seven-day windows work the same way on a longer scale. The all-models window opens with the first message of the week and resets seven days later to the minute. The per-model windows, for example the Fable one, open the first time that model is used and reset seven days after that, so they can land on a different day from the shared window.",
          "Because it is rolling, hitting the weekly limit on a Wednesday afternoon means waiting until the same time next Wednesday, unless the window opened earlier in the week, in which case the reset comes sooner.",
        ],
      },
      {
        heading: "Why the reset time seems to move",
        paragraphs: [
          "It does not move within a window, but each new window opens at a different time, so the reset you saw yesterday is not today's reset. If you use Claude every few hours the windows chain back to back and the reset times drift through the day. That is normal; it is the same rule applied each time.",
        ],
      },
      {
        heading: "Starting the clock on purpose",
        paragraphs: [
          "Since the window opens on the first message, a small message when you sit down starts the five hours early. If you start at 8 AM with a hello and do your heavy work from 10, the reset lands at 1 PM instead of 3 PM. Do this from your own Claude Code session; it is the same as any other message.",
        ],
      },
      {
        heading: "Seeing the exact reset",
        paragraphs: [
          "The reset time is not a guess. Anthropic's usage endpoint returns a timestamp for every window, and that is what the /usage command in Claude Code shows. AI Cooldown reads the same endpoint for each account you connect and turns the timestamps into countdowns, so you can see at a glance whether relief is nine minutes or two days away, and which account is back first.",
        ],
      },
    ],
    faq: [
      {
        q: "Does the Claude Code limit reset at midnight?",
        a: "No. The session window resets five hours after it opened, and the weekly windows reset seven days after they opened. Neither is tied to midnight or to any fixed hour.",
      },
      {
        q: "Does usage come back gradually during the window?",
        a: "No. The window resets all at once when it ends. Until then the used percentage only goes up.",
      },
      {
        q: "If I stop using Claude, does the window pause?",
        a: "No. The five hours run whether you use it or not, which is why starting the window early can help.",
      },
      {
        q: "Where can I see the exact reset time?",
        a: "In Claude Code with /usage, in claude.ai settings, or across all your accounts at once on AI Cooldown, which shows a countdown for every window.",
      },
    ],
    related: ["claude-code-usage-limit", "claude-weekly-limit", "codex-limit-reset"],
  },
  {
    slug: "claude-weekly-limit",
    title: "When does Claude's weekly usage limit reset?",
    description:
      "Claude's weekly limit is a rolling 7-day window that resets 7 days after it started, not on a fixed weekday. Fable, Opus and Sonnet can have their own weekly windows on top.",
    h1: "Claude's weekly usage limit: what it is and when it resets",
    answer:
      "Claude's weekly limit is a rolling seven-day window: it opens with your first message of the week and resets seven days later, to the minute, not on a Monday or at midnight. On top of the shared weekly window, some models, Fable in particular, have their own seven-day window, so you can run out of one model while the others still have room.",
    updated: UPDATED,
    sections: [
      {
        heading: "Why there is a weekly limit at all",
        paragraphs: [
          "The five-hour session window on its own let a small number of people run Claude Code continuously, around the clock, on a flat subscription. The weekly window was added on top so that heavy use is spread over the week. Most people never see it; people who run long agent sessions every day see it a lot.",
          "It applies to Pro and Max, scaled to the plan, and it covers Claude Code, the desktop app and claude.ai together, because they all belong to the same account.",
        ],
      },
      {
        heading: "Shared versus per-model",
        paragraphs: [
          "There are two flavours. The all-models window counts everything. The per-model windows count only that model; Fable's is the one people hit, because Fable is both the most capable and the most expensive model to run. When the Fable window is at 100% you can still use Sonnet or Opus until their windows or the shared one fill up.",
          "Which window is currently the one blocking you is reported by Anthropic along with the percentages. AI Cooldown marks it as limiting on the account card so you do not have to work it out.",
        ],
      },
      {
        heading: "Pacing a week",
        paragraphs: [
          "Because the window is seven days long, the useful number is not the percentage but the daily budget: what is left divided by the days until the reset. If you have 40% left and three days to go, you can spend about 13% a day and reach the reset with nothing wasted, or spend it all today and wait.",
          "AI Cooldown shows that budget on every weekly window next to what you have spent since midnight, and whether you are ahead of or behind the pace of the window itself.",
        ],
      },
      {
        heading: "When you hit it",
        bullets: [
          "Check whether it is the shared window or a per-model one. A per-model limit means switching model.",
          "If you have another account, its weekly window is independent.",
          "The reset is seven days after the window opened. If you have been using Claude all week, that is likely to be sooner than seven days from now.",
          "Anthropic has offered paid extra usage on some plans; if your account has it, it appears in usage settings when a window is exhausted.",
        ],
      },
    ],
    faq: [
      {
        q: "What day does the Claude weekly limit reset?",
        a: "There is no fixed day. It resets seven days after the window opened, which is seven days after your first message of that cycle.",
      },
      {
        q: "Is the Fable weekly limit separate from the normal weekly limit?",
        a: "Yes. Fable has its own seven-day window in addition to the shared all-models window. Either one can be the one that stops you.",
      },
      {
        q: "Does the weekly limit apply to claude.ai as well as Claude Code?",
        a: "Yes. It belongs to the account and covers every Anthropic product you use with it.",
      },
      {
        q: "How can I see how much of my week is left?",
        a: "Claude Code shows it with /usage. AI Cooldown shows the weekly windows for every account with a countdown to each reset and a daily budget.",
      },
    ],
    related: ["claude-code-limit-reset", "claude-code-usage-limit", "claude-vs-codex-limits"],
  },
  {
    slug: "codex-usage-limit",
    title: "Codex usage limits explained (ChatGPT Plus, Pro, Business)",
    description:
      "How OpenAI Codex usage limits work: the 5-hour window and the weekly window shared with your ChatGPT plan, what counts, model availability, credits, and how to check your usage.",
    h1: "Codex usage limits, explained",
    answer:
      "Codex, whether you use the CLI, the IDE extension or the cloud agent, draws on your ChatGPT plan's limits: a five-hour window and a seven-day window, each shown as a percentage with a reset time. Plus has smaller windows than Pro, and Business and Enterprise seats have their own allowances. When a window is full you can wait for its reset, switch to another account, or buy credits if your plan offers them.",
    updated: UPDATED,
    sections: [
      {
        heading: "The two windows",
        bullets: [
          "Primary, five hours. Opens with your first Codex request and closes five hours later. This is the one that stops you mid-task.",
          "Secondary, seven days. A rolling weekly cap over everything Codex does on the account. Heavy daily use runs into this one.",
        ],
        paragraphs: [
          "OpenAI reports both windows through the same usage endpoint the Codex CLI reads, as a percentage used plus the exact reset time. Those are the numbers AI Cooldown shows, so they match what the CLI tells you.",
        ],
      },
      {
        heading: "What counts",
        paragraphs: [
          "Every Codex task counts, weighted by how much the model works. Long agent runs with many tool calls, big repositories and large diffs cost more than a quick edit. Different models cost different amounts against the same window; the heavier reasoning models burn it faster. Plain ChatGPT chat has its own message limits and is counted separately from Codex.",
        ],
      },
      {
        heading: "Model availability and credits",
        paragraphs: [
          "Alongside the windows, the usage endpoint reports whether each model is currently available to you and, when it is not, when it comes back. A model can be temporarily unavailable on your plan even while your windows have room. AI Cooldown lists that per account.",
          "Some plans can buy credits that are used once the included windows are exhausted. If your account has a credit balance, or unlimited credits, the endpoint reports it and the dashboard shows it as a note on the account.",
        ],
      },
      {
        heading: "How to check your Codex usage",
        bullets: [
          "In the Codex CLI, the /status command shows the current windows and resets for the signed-in account.",
          "In ChatGPT, the account settings show usage for that account.",
          "AI Cooldown shows every window for every Codex and Claude account you connect, with countdowns, a Go or Wait verdict per provider, and which account has the most room. Sign in through the normal OpenAI login or paste the token from ~/.codex/auth.json.",
        ],
      },
    ],
    faq: [
      {
        q: "Does Codex share limits with ChatGPT chat?",
        a: "They belong to the same plan but are counted separately. Codex has its own five-hour and weekly windows; chat messages have their own caps.",
      },
      {
        q: "Are Codex limits the same on Plus and Pro?",
        a: "No. Pro windows are considerably larger than Plus windows. Business and Enterprise seats have their own allowances set by the workspace.",
      },
      {
        q: "What happens when the five-hour window is full?",
        a: "Codex stops accepting tasks on that account until the window resets, five hours after it opened. The weekly window may still have plenty left; it is the five-hour one that is blocking you.",
      },
      {
        q: "Can I keep working on another account?",
        a: "Yes. Limits are per account. AI Cooldown shows all of them side by side so you can see which one has room.",
      },
    ],
    related: ["codex-limit-reset", "claude-vs-codex-limits", "claude-code-usage-limit"],
  },
  {
    slug: "codex-limit-reset",
    title: "When does the Codex limit reset?",
    description:
      "The Codex 5-hour limit resets 5 hours after your first request opened the window; the weekly limit resets 7 days after it started. Neither is tied to midnight. How to see the exact time.",
    h1: "When does the Codex limit reset?",
    answer:
      "The five-hour Codex window resets five hours after the first request that opened it, and the weekly window resets seven days after it opened. Neither is tied to midnight or a fixed weekday. OpenAI reports the exact reset timestamp for each window, which is what the Codex CLI shows and what AI Cooldown turns into a countdown.",
    updated: UPDATED,
    sections: [
      {
        heading: "The rule",
        paragraphs: [
          "Both windows are rolling timers that start on first use. Run a Codex task at 10:05 AM and the five-hour window resets at 3:05 PM regardless of what you do in between. Nothing comes back early and nothing comes back gradually; at the reset the window is empty again and the next request starts a new one.",
          "The weekly window is the same on a seven-day scale. It opens with the first Codex task of the cycle and resets seven days later to the minute.",
        ],
      },
      {
        heading: "Why it is not at a round time",
        paragraphs: [
          "Because the window opens whenever you happen to start, the reset lands at whatever time that was plus five hours. If you use Codex several times a day the windows chain and the reset time drifts. It looks arbitrary but it is the same rule every time.",
        ],
      },
      {
        heading: "Seeing the exact moment",
        bullets: [
          "The Codex CLI shows it with /status.",
          "AI Cooldown shows a live countdown for every window on every account you connect, plus a timeline of all upcoming resets from one minute to seven days, so you can see which account is back first.",
        ],
      },
      {
        heading: "Making the wait shorter",
        paragraphs: [
          "If you know the day will be heavy, run a small task when you sit down so the five-hour window is already open. And if you keep more than one account, check the other one before waiting; its windows are independent.",
        ],
      },
    ],
    faq: [
      {
        q: "Does the Codex limit reset at midnight?",
        a: "No. The five-hour window resets five hours after it opened and the weekly window seven days after it opened.",
      },
      {
        q: "Does Codex usage come back gradually?",
        a: "No. A window resets all at once when it ends.",
      },
      {
        q: "Where do I see the reset time?",
        a: "In the Codex CLI with /status, or on AI Cooldown as a countdown for every account.",
      },
    ],
    related: ["codex-usage-limit", "claude-code-limit-reset", "claude-vs-codex-limits"],
  },
  {
    slug: "claude-vs-codex-limits",
    title: "Claude vs Codex usage limits compared",
    description:
      "How Claude Code and OpenAI Codex usage limits compare: windows, per-model limits, reset rules, what each plan costs, extra usage, and how to check both in one place.",
    h1: "Claude vs Codex: how the usage limits compare",
    answer:
      "Both work the same way at the core: a five-hour window that opens on first use and a rolling seven-day window, each reported as a percentage with an exact reset time. Claude adds per-model weekly windows (Fable, Opus, Sonnet); Codex adds per-model availability and purchasable credits. Neither resets at a fixed time of day, and both are per account, which is why people who use both keep more than one.",
    updated: UPDATED,
    sections: [
      {
        heading: "Side by side",
        table: {
          head: ["", "Claude (Pro, Max)", "Codex (Plus, Pro, Business)"],
          rows: [
            ["Short window", "5 hours, opens on first message", "5 hours, opens on first request"],
            ["Long window", "7 days, rolling, all models", "7 days, rolling"],
            ["Per-model limits", "Separate weekly windows, e.g. Fable, Opus, Sonnet", "None as windows; models can be temporarily unavailable"],
            ["Reset rule", "Fixed length from when the window opened", "Fixed length from when the window opened"],
            ["Reported as", "Percent used plus reset timestamp per window", "Percent used plus reset timestamp per window"],
            ["Extra usage", "Paid extra usage on some plans", "Credits on some plans"],
            ["Check in the CLI", "/usage in Claude Code", "/status in the Codex CLI"],
            ["Plans, list price", "Pro $20, Max 5x $100, Max 20x $200 per month", "Plus $20, Pro $200 per month; Business per seat"],
          ],
        },
      },
      {
        heading: "Where they differ in practice",
        paragraphs: [
          "Claude's per-model windows are the thing that surprises people. You can be at 30% on the shared weekly window and still be stopped because the Fable window is full. The answer is to switch model, not to wait. Codex does not split its windows by model, but a model can be switched off for your plan for a while, which the usage endpoint reports separately from the windows.",
          "Codex's credits and Claude's extra usage are both a way to keep going past the included windows for money, on the plans that offer them. Neither changes the windows themselves.",
        ],
      },
      {
        heading: "Using both",
        paragraphs: [
          "If you switch between Claude Code and Codex depending on the task, the useful view is both providers at once: which one has room right now, and how long until the other is back. AI Cooldown puts a Go or Wait verdict for each provider at the top, ranks your accounts by headroom, and lists every upcoming reset on one timeline. Everything comes from the two official usage endpoints, so the numbers match the CLIs.",
        ],
      },
    ],
    faq: [
      {
        q: "Which has the more generous limits, Claude or Codex?",
        a: "It depends on the plan and the model, and both change their allowances over time. Comparing percentages on the same afternoon is more useful than any published table; both report exact percentages through their usage endpoints.",
      },
      {
        q: "Do Claude and Codex limits reset at the same time?",
        a: "No. Each window resets a fixed time after it opened, and they open whenever you first use that provider, so the resets are unrelated.",
      },
      {
        q: "Can I see both in one place?",
        a: "Yes. AI Cooldown shows every Claude and Codex account you connect on one page with countdowns to each reset.",
      },
    ],
    related: ["claude-code-usage-limit", "codex-usage-limit", "claude-code-usage-tracker"],
  },
  {
    slug: "claude-code-usage-tracker",
    title: "How to check and track your Claude Code usage",
    description:
      "Every way to see your Claude Code usage: the /usage command, claude.ai settings, terminal monitors that read local logs, and AI Cooldown for official percentages across accounts.",
    h1: "How to check and track your Claude Code usage",
    answer:
      "The quickest check is the /usage command inside Claude Code, which shows each window and its reset for the signed-in account. For more than one account, or for Claude and Codex together, AI Cooldown shows every window with a countdown on one page, read from Anthropic's own usage endpoint. Terminal monitors that parse your local logs can add token counts and cost estimates, at the price of being estimates.",
    updated: UPDATED,
    sections: [
      {
        heading: "Inside Claude Code",
        paragraphs: [
          "Type /usage. It shows the session window, the weekly window and any per-model windows, each as a percentage with the reset time. This is the source of truth for the account you are signed into, and it is free. The limitation is that it is one account, in one terminal, when you remember to ask.",
        ],
      },
      {
        heading: "On claude.ai",
        paragraphs: [
          "The account settings show the same windows for the signed-in account. Same limitation: one account at a time, and you have to go and look.",
        ],
      },
      {
        heading: "Terminal monitors that read local logs",
        paragraphs: [
          "Tools such as Claude Code Usage Monitor watch the JSONL logs Claude Code writes under your home directory and add up tokens per session, then estimate cost and predict when you will hit a limit. They are useful for seeing how many tokens a session actually took and what it would have cost on the API. The trade-off is that the limits themselves are inferred, not read, so the percentages can disagree with what Anthropic reports, and they only see the machine they run on.",
        ],
      },
      {
        heading: "AI Cooldown",
        paragraphs: [
          "AI Cooldown reads the same official usage endpoint the CLI uses, for every Claude and Codex account you connect, and shows the result on one page: each window with a countdown to its reset, the one that is currently limiting you flagged, a Go or Wait verdict per provider, the accounts ranked by headroom, and a timeline of every upcoming reset. It also keeps a 48-hour history in your browser to show your burn rate and whether you will run dry before the reset.",
          "Connect an account by signing in through the normal Claude login, or by pasting the token Claude Code already saved in ~/.claude/.credentials.json. It reads limits and your account email, nothing else. The code is open source and you can run it yourself if you would rather not use the hosted version.",
        ],
      },
      {
        heading: "Which one to use",
        bullets: [
          "One account, occasional check: /usage.",
          "Several accounts, or Claude and Codex together, and you want to know which to use right now: AI Cooldown.",
          "You want token counts and API-equivalent cost per session on your own machine: a local log monitor, alongside either of the above.",
        ],
      },
    ],
    faq: [
      {
        q: "Is there a built-in way to see Claude Code usage?",
        a: "Yes, the /usage command shows each window and its reset time for the signed-in account.",
      },
      {
        q: "Can I track usage across several Claude accounts?",
        a: "The built-in tools show one account at a time. AI Cooldown shows all of them side by side, with Codex accounts too.",
      },
      {
        q: "Does AI Cooldown see my conversations?",
        a: "No. It reads the usage endpoint, which returns percentages, reset times and the account email. Signed-in tokens are encrypted at rest and never sent back to the browser; without signing in they stay in your browser.",
      },
    ],
    related: ["claude-code-usage-limit", "claude-code-limit-reset", "codex-usage-limit"],
  },
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
