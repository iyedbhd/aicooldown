import type { Metadata } from "next";
import { TeamConsole } from "@/components/TeamConsole";

export const metadata: Metadata = {
  title: "Team",
  description: "Your team's connected computers, their Claude Code and Codex sessions, projects, token usage and account limits, and sessions started on a computer from the dashboard.",
  robots: { index: false },
};

export default function TeamPage() {
  return <TeamConsole />;
}
