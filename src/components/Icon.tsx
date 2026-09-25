type Name =
  | "refresh"
  | "bell"
  | "bellOff"
  | "copy"
  | "check"
  | "sun"
  | "moon"
  | "plus"
  | "chevron"
  | "user"
  | "logout"
  | "trash"
  | "clock"
  | "gauge"
  | "calendar"
  | "flame"
  | "trend"
  | "star"
  | "download"
  | "users"
  | "monitor"
  | "folder"
  | "terminal"
  | "play"
  | "stop"
  | "link"
  | "x"
  | "shield"
  | "eye"
  | "lock";

const PATHS: Record<Name, string> = {
  star: "M12 2.8l2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.3l-5.7 3.1 1.2-6.4-4.7-4.5 6.4-.8z",
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
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  terminal: "M4 17l6-6-6-6M12 19h8",
  play: "M6 4l14 8-14 8z",
  stop: "M6 6h12v12H6z",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  x: "M18 6 6 18M6 6l12 12",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
};

type Props = { name: Name; size?: number; className?: string; strokeWidth?: number; fill?: boolean };

/** Inline stroke icons (currentColor), small enough to sit inside buttons and chips. `fill` also fills the shape. */
export function Icon({ name, size = 14, className, strokeWidth = 2, fill = false }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
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
