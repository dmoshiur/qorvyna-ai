import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { AgentOpsControlCenter } from "@/components/agentops/agentops-control-center";

export const metadata = {
  title: "AgentOps Control Center",
  description:
    "Real-time agent execution monitoring, intelligent circuit breaker, human-in-the-loop governance, OpenTelemetry traces, and evaluation economics.",
} as const;

export const dynamic = "force-dynamic";

export default async function AgentOpsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AgentOpsControlCenter />;
}
