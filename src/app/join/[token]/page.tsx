import type { Metadata } from "next";
import { JoinTeam } from "@/components/JoinTeam";

export const metadata: Metadata = { title: "Join a team", robots: { index: false } };

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinTeam token={token} />;
}
