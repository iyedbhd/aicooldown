import Link from "next/link";
import { Dashboard } from "@/components/Dashboard";
import { GUIDES } from "@/content/guides";
import { SITE } from "@/lib/site";

/*
 * The dashboard itself is a client app, so this file also renders what a
 * crawler needs: a plain description of what the site does, structured data,
 * and links to the guides.
 */
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE.name,
  url: `https://${SITE.domain}`,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description: SITE.description,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://opensource.org/licenses/MIT",
  sameAs: [SITE.repo],
};

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      <Dashboard />
      <section className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
        <div className="grid gap-8 border-t border-line pt-8 md:grid-cols-2">
          <div>
            <h2 className="text-sm font-medium text-muted">What this is</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
              {SITE.name} is a free, open-source dashboard for the usage limits on your Claude (Pro, Max) and ChatGPT/Codex (Plus, Pro) accounts. It reads the same
              official usage endpoints the Claude Code and Codex CLIs use, and shows every window for every account on one page: the 5-hour session, the weekly
              limit, the per-model weekly limits such as Fable, a live countdown to each reset, which window is limiting you, and which account to use next.
              Tokens are encrypted at rest when you sign in, or stay in your browser when you do not, and you can self-host it. The desktop app for
              Windows, macOS and Linux adds switching which account the Claude Code and Codex CLIs are logged in with.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-medium text-muted">Guides</h2>
            <ul className="mt-2 space-y-1.5">
              {GUIDES.map((g) => (
                <li key={g.slug}>
                  <Link href={`/${g.slug}`} className="text-[15px] text-fg-2 hover:text-accent">
                    {g.h1}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
