"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";

/**
 * A page that crashed shows this instead, inside the app shell, which keeps
 * running: polling, notifications and, in the desktop app, the tray status go
 * on while the page is retried.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <Icon name="info" size={28} className="text-rose-500" />
      <h1 className="mt-4 text-lg font-semibold text-fg">This page ran into a problem</h1>
      <p className="mt-2 text-sm text-muted">{error.message || "Something went wrong while showing it."} Your accounts are still being watched.</p>
      <div className="mt-6 flex gap-2">
        <button type="button" onClick={() => retry()} className="btn btn-primary">
          <Icon name="refresh" />
          Try again
        </button>
        <Link href="/" className="btn">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
