import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { SITE } from "@/lib/site";
import { THEME_INIT } from "@/lib/theme-init";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${SITE.name} · Claude & Codex usage limits and reset times`, template: `%s · ${SITE.name}` },
  keywords: ["Claude Code usage limit", "Claude weekly limit reset", "Codex usage limit", "Codex limit reset", "Claude usage tracker", "AI rate limit dashboard"],
  alternates: { canonical: "/" },
  description: SITE.description,
  metadataBase: new URL(`https://${SITE.domain}`),
  openGraph: { title: SITE.name, description: SITE.description, siteName: SITE.name, type: "website", url: "/" },
  twitter: { card: "summary_large_image", title: SITE.name, description: SITE.description },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Before paint, so the page never flashes the wrong theme, or the website's chrome in the desktop app. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
