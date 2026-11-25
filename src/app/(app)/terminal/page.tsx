import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { AiCodingWorkspace } from "@/components/terminal/ai-coding-workspace";

export const metadata: Metadata = {
  title: "AI Terminal & Coding Workspace · QORVYNA AI",
  description:
    "Governed workspace terminal (qsh), multi-file code editor, live preview, and diff-reviewed AI coding studio by OKGS.",
};

export default async function TerminalWorkspacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AiCodingWorkspace />;
}
