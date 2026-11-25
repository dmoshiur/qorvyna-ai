import { NextRequest, NextResponse } from "next/server";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getApiSessionUser } from "@/lib/firebase/device-session";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { invokeMcpConnector, listMcpConnectors } from "@/lib/server/mcp/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const connectors = await listMcpConnectors(adminDb(), user);
  return NextResponse.json({ connectors });
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  const db = adminDb();
  const result = await invokeMcpConnector(db, user, body);
  await db
    .collection("audit_logs")
    .add({
      actor_id: user.uid,
      action: result.ok ? "mcp.invoke.ok" : "mcp.invoke.denied",
      target_type: "mcp_connector",
      target_id: result.connector,
      reason: result.error ?? result.operation,
      metadata: { operation: result.operation, trust: result.trust },
      created_at: nowTs(),
    })
    .catch(() => {});

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
