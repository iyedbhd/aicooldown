"use client";

import type { ReactNode } from "react";

/** An on/off toggle, Windows 11 style: a pill with a knob, "On"/"Off" beside it. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 rounded-full text-xs text-muted disabled:opacity-40"
    >
      <span className="w-6 text-right tabular-nums">{checked ? "On" : "Off"}</span>
      <span
        className={`relative h-5 w-10 rounded-full border transition-colors ${
          checked ? "border-accent bg-accent" : "border-muted bg-transparent group-hover:border-fg-2 group-enabled:group-hover:bg-panel-3"
        }`}
      >
        <span
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ${checked ? "left-[22px] bg-bg" : "left-[3px] bg-muted group-hover:bg-fg-2"}`}
        />
      </span>
    </button>
  );
}

/** A choice of a few options side by side. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs transition-colors ${o.value === value ? "bg-panel-3 font-medium text-fg shadow-sm" : "text-muted hover:text-fg-2"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One setting: what it is on the left, its control on the right, like a Windows 11 settings card. */
export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-line bg-panel-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm text-fg">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A keyboard shortcut, key by key. */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.split("+").map((k) => (
        <kbd key={k} className="rounded-md border border-line bg-panel-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2">
          {k}
        </kbd>
      ))}
    </span>
  );
}
