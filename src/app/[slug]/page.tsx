import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuidePage } from "@/components/GuidePage";
import { GUIDES, guideBySlug } from "@/content/guides";
import { SITE } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) return {};
  return {
    title: { absolute: guide.title },
    description: guide.description,
    alternates: { canonical: `/${guide.slug}` },
    openGraph: { title: guide.title, description: guide.description, type: "article", url: `/${guide.slug}`, siteName: SITE.name },
    twitter: { card: "summary_large_image", title: guide.title, description: guide.description },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) notFound();
  return <GuidePage guide={guide} />;
}
