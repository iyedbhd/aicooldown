type Name = "refresh" | "bell" | "bellOff" | "copy" | "check" | "sun" | "moon" | "plus" | "chevron" | "user" | "logout" | "trash" | "clock" | "gauge" | "calendar" | "flame" | "trend";

const PATHS: Record<Name, string> = {
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  bellOff: "M8.7 3A6 6 0 0 1 18 8c0 4.5 1.2 6.8 2.1 8M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20",
  copy: "M9 9h11v11H9zM4 15V4h11",
  check: "M20 6 9 17l-5-5",
  sun: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  plus: "M12 5v14M5 12h14",
  chevron: "m6 9 6 6 6-6",
  user: "M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  logout: "M16 17l5-5-5-5M21 12H9M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  gauge: "M12 15l3.5-5.5M5 19a9 9 0 1 1 14 0",
  calendar: "M4 6h16v14H4zM8 3v4M16 3v4M4 10h16",
  flame: "M12 22c4 0 7-3 7-7 0-3-2-5-3-6-.5 2-1.5 3-2.5 3.5C14 9 13 6 9.5 4 10 8 7 10 6 13c-1 3 1 9 6 9",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
};

type Props = { name: Name; size?: number; className?: string; strokeWidth?: number };

/** Inline stroke icons (currentColor), small enough to sit inside buttons and chips. */
export function Icon({ name, size = 14, className, strokeWidth = 2 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
