import { useId } from "react";
import { markBody } from "@/lib/brand";

/*
 * The AI Cooldown mark, drawn from lib/brand.ts like every logo file, so the
 * header and the favicon can never drift apart. `animated` plays the cooldown
 * with the keyframes in globals.css, which stop under reduced motion.
 */

type MarkProps = { size?: number; animated?: boolean; className?: string; title?: string };

export function Mark({ size = 32, animated = false, className, title = "AI Cooldown" }: MarkProps) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: markBody({ id, animate: animated ? "css" : undefined }) }}
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-semibold tracking-[-0.03em] text-fg ${className ?? ""}`}>AI Cooldown</span>;
}
