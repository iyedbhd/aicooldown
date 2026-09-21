import type { Metadata } from "next";
import Link from "next/link";
import { Mark, Wordmark } from "@/components/Logo";
import { GUIDES } from "@/content/guides";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Guides to Claude and Codex usage limits",
  description: "Plain answers about Claude Code and Codex usage limits: what the windows are, when they reset, how the two compare, and how to check your usage.",
  alternates: { canonical: "/guides" },
};

export default function GuidesIndex() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header>
        <Link href="/" className="flex items-center gap-2.5">
          <Mark size={32} />
          <Wordmark className="text-lg" />
        </Link>
      </header>
      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-fg">Guides to Claude and Codex usage limits</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-fg-2">
        Short, direct answers to the questions people ask when a limit stops them. Each one ends with how to see the exact numbers for your own accounts on{" "}
        {SITE.name}.
      </p>
      <ul className="mt-8 divide-y divide-line">
        {GUIDES.map((g) => (
          <li key={g.slug} className="py-4">
            <Link href={`/${g.slug}`} className="text-lg font-medium text-fg hover:text-accent">
              {g.h1}
            </Link>
            <p className="mt-1 text-sm text-muted">{g.description}</p>
          </li>
        ))}
      </ul>
      <footer className="mt-12 border-t border-line pt-4 font-mono text-[11px] text-faint">
        <Link href="/" className="text-muted hover:text-fg">
          {SITE.name}
        </Link>{" "}
        · open source under MIT · not affiliated with Anthropic or OpenAI
      </footer>
    </main>
  );
}
