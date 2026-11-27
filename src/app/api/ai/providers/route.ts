import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { addUserProvider, listUserProviders } from "@/lib/server/provider-vault";
import { RpcError } from "@/lib/server/errors";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(60),
  base_url: z.string().min(1).max(300),
  api_key: z.string().min(1).max(512),
  models: z.array(z.object({ id: z.string().min(1).max(220), label: z.string().max(80).optional() })).min(1).max(20),
  enabled: z.boolean().optional(),
});

/** List the calling user's own providers only (never another user's). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const providers = await listUserProviders(adminDb(), user.uid);
  return NextResponse.json({ providers }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Add a provider: validates, tests the connection, encrypts the key at rest. */
export async function POST(request: Request) {
  const csrf = mutationCsrfResponse(request);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  try {
    const provider = await addUserProvider(adminDb(), user.uid, body);
    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    if (error instanceof RpcError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status ?? 400 });
    }
    return NextResponse.json({ error: "PROVIDER_ADD_FAILED" }, { status: 500 });
  }
}
