import Link from "next/link";
import type { Guide } from "@/content/guides";
import { GUIDES } from "@/content/guides";
import { SITE } from "@/lib/site";
import { Mark, Wordmark } from "./Logo";

/** Static, crawlable layout for one guide: the answer first, then the detail, the FAQ, and the pointer to the dashboard. */
export function GuidePage({ guide }: { guide: Guide }) {
  const url = `https://${SITE.domain}/${guide.slug}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: guide.h1,
      description: guide.description,
      datePublished: guide.updated,
      dateModified: guide.updated,
      mainEntityOfPage: url,
      author: { "@type": "Organization", name: SITE.name, url: `https://${SITE.domain}` },
      publisher: { "@type": "Organization", name: SITE.name, url: `https://${SITE.domain}` },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: guide.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE.name, item: `https://${SITE.domain}/` },
        { "@type": "ListItem", position: 2, name: "Guides", item: `https://${SITE.domain}/guides` },
        { "@type": "ListItem", position: 3, name: guide.h1, item: url },
      ],
    },
  ];
  const related = guide.related.map((s) => GUIDES.find((g) => g.slug === s)).filter((g): g is Guide => Boolean(g));
  const updated = new Date(guide.updated).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Mark size={32} />
          <Wordmark className="text-lg" />
        </Link>
        <Link href="/guides" className="eyebrow hover:text-fg-2">
          all guides
        </Link>
      </header>

      <article className="mt-10">
        <p className="eyebrow">updated {updated}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{guide.h1}</h1>
        <p className="mt-5 rounded-2xl border border-line bg-panel px-5 py-4 text-[15px] leading-relaxed text-fg-2">{guide.answer}</p>

        {guide.sections.map((s) => (
          <section key={s.heading} className="mt-9">
            <h2 className="text-xl font-semibold text-fg">{s.heading}</h2>
            {s.paragraphs?.map((p, i) => (
              <p key={i} className="mt-3 text-[15px] leading-relaxed text-fg-2">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-fg-2">
                {s.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
            {s.table && (
              <div className="mt-4 overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-panel-2 text-left text-xs uppercase tracking-wider text-muted">
                    <tr>
                      {s.table.head.map((h, i) => (
                        <th key={i} className="px-3 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {s.table.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} className={`px-3 py-2 align-top ${j === 0 ? "font-medium text-fg" : "text-fg-2"}`}>
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}

        <section className="mt-10 rounded-2xl border border-accent/40 bg-panel p-5">
          <p className="eyebrow">see your exact numbers</p>
          <h2 className="mt-1 text-lg font-semibold text-fg">Want the exact reset for your accounts?</h2>
          <p className="mt-2 text-sm text-fg-2">
            Connect your Claude and Codex accounts to {SITE.name} and get every window with a live countdown, which one is limiting you, and which account
            to use next. Free, open source, and it reads the same official usage endpoints the CLIs use.
          </p>
          <Link href="/" className="btn btn-primary mt-4">
            Connect an account
          </Link>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-fg">Questions people ask</h2>
          <dl className="mt-3 divide-y divide-line">
            {guide.faq.map((f) => (
              <div key={f.q} className="py-3">
                <dt className="font-medium text-fg">{f.q}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-fg-2">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {related.length > 0 && (
          <section className="mt-10">
            <h2 className="eyebrow">related</h2>
            <ul className="mt-2 space-y-1.5">
              {related.map((g) => (
                <li key={g.slug}>
                  <Link href={`/${g.slug}`} className="text-sm text-accent hover:underline">
                    {g.h1}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 font-mono text-[11px] text-faint">
        <span>
          <Link href="/" className="text-muted hover:text-fg">
            {SITE.name}
          </Link>{" "}
          · open source under MIT
        </span>
        <span>Not affiliated with Anthropic or OpenAI</span>
      </footer>
    </main>
  );
}
