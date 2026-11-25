import { NextRequest, NextResponse } from "next/server";
import {
  getServerAgentOps,
  HttpError,
  requireOperatorForExecution,
} from "@/lib/agentops/server";
import { recordToLogs, recordToSpans, toOtlpJson } from "@/lib/agentops/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { record } = await requireOperatorForExecution(req, id);
    const storage = getServerAgentOps().getStorage();
    const spans = recordToSpans(record);
    const logs = recordToLogs(record);
    const [audit, memory] = await Promise.all([
      storage.listAudit(record.executionId, 200),
      storage.listMemory(record.executionId),
    ]);
    return NextResponse.json({
      execution: record,
      spans,
      logs,
      otlp: toOtlpJson(spans),
      audit,
      memory,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
