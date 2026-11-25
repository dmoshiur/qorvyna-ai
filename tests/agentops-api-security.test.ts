import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getExecutions } from "@/app/api/agentops/executions/route";
import { POST as postControl } from "@/app/api/agentops/executions/[id]/control/route";
import { GET as getTelemetry } from "@/app/api/agentops/telemetry/route";
import { GET as getEvaluations, POST as postEvaluation } from "@/app/api/agentops/evaluations/route";
import { GET as getGithubSync, POST as postGithubSync } from "@/app/api/github/sync/route";
import { GET as getPrReview, POST as postPrReview } from "@/app/api/github/pull-requests/review/route";
import { GET as getMcp, POST as postMcp } from "@/app/api/mcp/connectors/route";
import { GET as getLifecycle, POST as postLifecycle } from "@/app/api/admin/lifecycle/route";
import { GET as getTerminal, POST as postTerminal } from "@/app/api/terminal/route";

function crossOriginPost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.evil.example",
      Host: "qorvyna.okgs.info",
    },
    body: JSON.stringify(body),
  });
}

function unauthedSameOriginPost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://qorvyna.okgs.info",
      Host: "qorvyna.okgs.info",
    },
    body: JSON.stringify(body),
  });
}

describe("API Route Security: AuthN (401) & Cross-Origin CSRF (403) across all new endpoints", () => {
  it("rejects unauthenticated GET requests with 401 across AgentOps, GitHub Sync/Review, MCP, Lifecycle, and Terminal", async () => {
    const endpoints = [
      () => getExecutions(new NextRequest("https://qorvyna.okgs.info/api/agentops/executions")),
      () => getTelemetry(new NextRequest("https://qorvyna.okgs.info/api/agentops/telemetry")),
      () => getEvaluations(new NextRequest("https://qorvyna.okgs.info/api/agentops/evaluations")),
      () => getGithubSync(new NextRequest("https://qorvyna.okgs.info/api/github/sync")),
      () => getPrReview(new NextRequest("https://qorvyna.okgs.info/api/github/pull-requests/review?repository=a/b&number=1")),
      () => getMcp(new NextRequest("https://qorvyna.okgs.info/api/mcp/connectors")),
      () => getLifecycle(new NextRequest("https://qorvyna.okgs.info/api/admin/lifecycle")),
      () => getTerminal(new NextRequest("https://qorvyna.okgs.info/api/terminal")),
    ];

    for (const call of endpoints) {
      const res = await call();
      expect(res.status).toBe(401);
    }
  });

  it("blocks cross-origin POST mutations with 403 CSRF protection and unauthenticated same-origin POSTs with 401", async () => {
    const mutations = [
      {
        cross: () =>
          postControl(crossOriginPost("https://qorvyna.okgs.info/api/agentops/executions/ex1/control", { kind: "pause" }), {
            params: Promise.resolve({ id: "ex1" }),
          }),
        unauthed: () =>
          postControl(unauthedSameOriginPost("https://qorvyna.okgs.info/api/agentops/executions/ex1/control", { kind: "pause" }), {
            params: Promise.resolve({ id: "ex1" }),
          }),
      },
      {
        cross: () => postEvaluation(crossOriginPost("https://qorvyna.okgs.info/api/agentops/evaluations", {})),
        unauthed: () => postEvaluation(unauthedSameOriginPost("https://qorvyna.okgs.info/api/agentops/evaluations", {})),
      },
      {
        cross: () => postGithubSync(crossOriginPost("https://qorvyna.okgs.info/api/github/sync", { action: "revoke_and_disconnect" })),
        unauthed: () => postGithubSync(unauthedSameOriginPost("https://qorvyna.okgs.info/api/github/sync", { action: "revoke_and_disconnect" })),
      },
      {
        cross: () => postPrReview(crossOriginPost("https://qorvyna.okgs.info/api/github/pull-requests/review", {})),
        unauthed: () => postPrReview(unauthedSameOriginPost("https://qorvyna.okgs.info/api/github/pull-requests/review", {})),
      },
      {
        cross: () => postMcp(crossOriginPost("https://qorvyna.okgs.info/api/mcp/connectors", {})),
        unauthed: () => postMcp(unauthedSameOriginPost("https://qorvyna.okgs.info/api/mcp/connectors", {})),
      },
      {
        cross: () => postLifecycle(crossOriginPost("https://qorvyna.okgs.info/api/admin/lifecycle", { action: "cleanup_ephemeral" })),
        unauthed: () => postLifecycle(unauthedSameOriginPost("https://qorvyna.okgs.info/api/admin/lifecycle", { action: "cleanup_ephemeral" })),
      },
      {
        cross: () => postTerminal(crossOriginPost("https://qorvyna.okgs.info/api/terminal", { action: "init_project" })),
        unauthed: () => postTerminal(unauthedSameOriginPost("https://qorvyna.okgs.info/api/terminal", { action: "init_project" })),
      },
    ];

    for (const m of mutations) {
      const csrfRes = await m.cross();
      expect(csrfRes.status).toBe(403);
      const authRes = await m.unauthed();
      expect(authRes.status).toBe(401);
    }
  });
});
