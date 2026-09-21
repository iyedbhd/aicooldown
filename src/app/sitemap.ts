import type { MetadataRoute } from "next";
import { GUIDES } from "@/content/guides";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${SITE.domain}`;
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/guides`, changeFrequency: "weekly", priority: 0.7 },
    ...GUIDES.map((g) => ({ url: `${base}/${g.slug}`, lastModified: new Date(g.updated), changeFrequency: "monthly" as const, priority: 0.8 })),
    { url: `${base}/brand`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
