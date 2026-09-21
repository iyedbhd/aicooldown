"use client";

import { useEffect, useRef, useState } from "react";

/** Eases a displayed number toward `value` so changes read as motion, not jumps. */
export function useAnimatedNumber(value: number, durationMs = 700): number {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = from + (value - from) * eased;
      setShown(next);
      if (p < 1) frame.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return shown;
}
