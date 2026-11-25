import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import {
  applyControl,
  getServerAgentOps,
  HttpError,
  requireOperatorForExecution,
} from "@/lib/agentops/server";
import type { GovernanceAction } from "@/lib/agentops/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const controlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause"), reason: z.string().max(300).optional() }),
  z.object({ kind: z.literal("resume"), reason: z.string().max(300).optional() }),
  z.object({ kind: z.literal("cancel"), reason: z.string().max(300).optional() }),
  z.object({ kind: z.literal("approve"), approvalId: z.string().min(1).max(160) }),
  z.object({ kind: z.literal("reject"), approvalId: z.string().min(1).max(160), reason: z.string().max(300).optional() }),
  z.object({
    kind: z.literal("edit_memory"),
    target: z.string().min(1).max(80),
    operation: z.enum(["append", "replace", "delete"]),
    content: z.string().max(4000).optional(),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal("override"),
    decision: z.string().min(1).max(200),
    reason: z.string().max(300).optional(),
  }),
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  try {
    const { id } = await context.params;
    const { user, record, db } = await requireOperatorForExecution(req, id);
    let parsed: z.infer<typeof controlSchema>;
    try {
      parsed = controlSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
    }
    const at = Date.now();
    const action: GovernanceAction = { ...parsed, operatorId: user.uid, at } as GovernanceAction;
    const updated = await applyControl(db, record, user, action);
    const storage = getServerAgentOps().getStorage();
    const [audit, memory] = await Promise.all([
      storage.listAudit(updated.executionId, 200),
      storage.listMemory(updated.executionId),
    ]);
    return NextResponse.json({ ok: true, execution: updated, audit, memory });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
