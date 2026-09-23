import type { Metadata } from "next";
import Link from "next/link";
import { Mark, Wordmark } from "@/components/Logo";
import { BRAND } from "@/lib/brand";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "Brand" };

const RING_NAMES = ["amber", "coral", "pink", "violet", "blue", "cyan"];
const COLORS: { name: string; value: string; swatch?: string; use: string }[] = [
  { name: "ink", value: `${BRAND.inkTop} → ${BRAND.ink}`, swatch: `linear-gradient(135deg, ${BRAND.inkTop}, ${BRAND.ink})`, use: "tile" },
  { name: "halo", value: BRAND.halo, use: "glow behind the sparkle" },
  { name: "tip", value: BRAND.tip, use: "head dot" },
  { name: "ice", value: BRAND.ice, use: "sparkle, from white" },
  ...BRAND.ring.map((value, i) => ({
    name: RING_NAMES[i],
    value,
    use: i === 0 ? "ring · head" : i === BRAND.ring.length - 1 ? "ring · tail" : "ring",
  })),
];

const DOWNLOADS = [
  ["/mark.svg", "animated square tile"],
  ["/logo.svg", "lockup for dark backgrounds"],
  ["/logo-on-light.svg", "lockup for light backgrounds"],
  ["/icon.svg", "favicon, bolder for 16px"],
  ["/icon.png", "192px PNG"],
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
        One ring, almost full, running hot to cold: amber at a white-hot head, then coral, pink, violet and blue, to ice
        cyan at the tail, a cooldown running out. Inside it, the AI sparkle, which flares when the ring closes. Free to
        use when linking to or writing about {SITE.name}.
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
        <ul className="mt-2 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-5">
          {COLORS.map((c) => (
            <li key={c.name} className="bg-panel p-3">
              <div className="h-10 w-full" style={{ background: c.swatch ?? c.value }} />
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
          {DOWNLOADS.map(([href, what]) => (
            <li key={href}>
              <a href={href} download className="text-accent hover:underline">
                {href.slice(1)}
              </a>{" "}
              <span className="text-faint">{what}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
