import type { Metadata } from "next";
import Link from "next/link";
import { BRAND, Mark, Wordmark } from "@/components/Logo";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "Brand" };

const RING_NAMES = ["red", "orange", "amber", "yellow", "lime", "green"];
const COLORS: { name: string; value: string; use: string }[] = [
  { name: "ink", value: BRAND.ink, use: "tile" },
  { name: "tip", value: BRAND.tip, use: "head dot" },
  ...BRAND.ring.map((value, i) => ({
    name: RING_NAMES[i],
    value,
    use: i === 0 ? "ring · head" : i === BRAND.ring.length - 1 ? "ring · tail" : "ring",
  })),
];

export default function BrandPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <p className="eyebrow">
        <Link href="/" className="hover:text-fg-2">
          ← {SITE.name}
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-fg">Brand assets</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        One ring, almost full, with a white-hot head. The colour runs along the arc: red at the head, orange, amber,
        yellow, then lime and green at the tail, a meter clearing as the cooldown runs out. Free to use when linking to
        or writing about {SITE.name}.
      </p>

      <section className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-2">
        <div className="flex flex-col items-center justify-center gap-6 bg-panel p-10">
          <Mark size={176} animated />
          <span className="eyebrow">mark · animated</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-6 bg-[#f4f4f5] p-10">
          <Mark size={176} />
          <span className="eyebrow">mark · on light</span>
        </div>
        <div className="flex items-center justify-center gap-4 bg-panel p-10">
          <Mark size={48} />
          <Wordmark className="text-3xl" />
        </div>
        <div className="flex items-center justify-center gap-8 bg-panel p-10">
          {[64, 32, 16].map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <Mark size={s} />
              <span className="font-mono text-[10px] text-muted">{s}px</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <p className="eyebrow">colors</p>
        <ul className="mt-2 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4 lg:grid-cols-8">
          {COLORS.map((c) => (
            <li key={c.name} className="bg-panel p-3">
              <div className="h-10 w-full" style={{ background: c.value }} />
              <div className="mt-2 text-sm text-fg-2">{c.name}</div>
              <div className="font-mono text-[11px] text-muted">{c.value}</div>
              <div className="text-[11px] text-faint">{c.use}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <p className="eyebrow">downloads</p>
        <ul className="mt-2 flex flex-wrap gap-4 font-mono text-[12px]">
          <li>
            <a href="/mark.svg" download className="text-accent hover:underline">
              mark.svg
            </a>{" "}
            <span className="text-faint">animated square tile</span>
          </li>
          <li>
            <a href="/logo.svg" download className="text-accent hover:underline">
              logo.svg
            </a>{" "}
            <span className="text-faint">horizontal lockup</span>
          </li>
          <li>
            <a href="/icon.svg" download className="text-accent hover:underline">
              icon.svg
            </a>{" "}
            <span className="text-faint">favicon, thicker for 16px</span>
          </li>
        </ul>
      </section>
    </main>
  );
}
