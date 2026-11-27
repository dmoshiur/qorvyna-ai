import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { deleteUserProvider, reverifyProvider, setProviderEnabled } from "@/lib/server/provider-vault";
import { RpcError } from "@/lib/server/errors";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  test: z.boolean().optional(),
});

/** Enable/disable or re-verify a provider the caller owns. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = mutationCsrfResponse(request);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await params;
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  try {
    if (body.test) {
      const provider = await reverifyProvider(adminDb(), user.uid, id);
      return NextResponse.json({ provider });
    }
    if (typeof body.enabled === "boolean") {
      const provider = await setProviderEnabled(adminDb(), user.uid, id, body.enabled);
      return NextResponse.json({ provider });
    }
    return NextResponse.json({ error: "NO_OP" }, { status: 400 });
  } catch (error) {
    if (error instanceof RpcError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status ?? 400 });
    return NextResponse.json({ error: "PROVIDER_UPDATE_FAILED" }, { status: 500 });
  }
}

/** Delete a provider the caller owns. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = mutationCsrfResponse(_request);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await params;
  try {
    await deleteUserProvider(adminDb(), user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RpcError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status ?? 400 });
    return NextResponse.json({ error: "PROVIDER_DELETE_FAILED" }, { status: 500 });
  }
}
