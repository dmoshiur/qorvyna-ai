// GET /api/health — honest, machine-readable service health for operators and
// uptime checks. No secrets are returned. AI inference is never triggered here.
//
//   200 { ok: true,  firebase: "reachable", webConfig: "valid", cloudinary: "reachable", ai: "unknown"|"not-configured", checkedAt }
//   503 { ok: false, firebase: "not-configured"|"unreachable", webConfig: "invalid-key"|"project-mismatch"|…, … }
//
// `webConfig` independently probes the public web API key against Identity
// Toolkit, so a bad NEXT_PUBLIC_FIREBASE_API_KEY (the classic Render
// misconfiguration) is reported even when the Admin SDK is also unset.

import { NextResponse } from "next/server";
import { isConfigured, isCloudinaryConfigured } from "@/lib/env";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";
import { createAIRoutes, createAIRoutesFromDb, logAIConfiguration } from "@/lib/ai/config";
import { ping as pingCloudinary } from "@/lib/server/cloudinary";
import { checkWebFirebaseConfig } from "@/lib/server/identitytoolkit";
import { isImageGenerationConfigured } from "@/lib/ai/image/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  logAIConfiguration();
  const checkedAt = new Date().toISOString();

  const webConfig = await checkWebFirebaseConfig();
  const webConfigFields = {
    webConfig: webConfig.status,
    ...(webConfig.reportedProjectId ? { webConfigProject: webConfig.reportedProjectId } : {}),
  };

  if (!isConfigured() || !adminConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        firebase: "not-configured",
        ...webConfigFields,
        cloudinary: isCloudinaryConfigured() ? "unknown" : "not-configured",
        ai: createAIRoutes(false).length ? "unknown" : "not-configured",
        codingAi: createAIRoutes(true).length ? "unknown" : "not-configured",
        imageAi: "unknown",
        checkedAt,
      },
      { status: 503 },
    );
  }

  let firebase: "reachable" | "unreachable" = "unreachable";
  try {
    // Minimal live read (also proves the service account works).
    await adminDb().collection("countries").limit(1).get();
    firebase = "reachable";
  } catch {
    firebase = "unreachable";
  }

  let cloudinary: "reachable" | "unreachable" | "unknown" = "unknown";
  if (isCloudinaryConfigured()) {
    cloudinary = (await pingCloudinary()) ? "reachable" : "unreachable";
  }

  let runtimeDb: ReturnType<typeof adminDb> | null = null;
  try {
    runtimeDb = adminDb();
  } catch {
    /* not configurable yet — env fallback only */
  }

  // Configuration alone is not evidence of liveness. Public uptime checks must
  // not trigger billable inference, even when called repeatedly or in parallel.
  const generalTargets = await createAIRoutesFromDb(runtimeDb, false);
  const ai = generalTargets.length ? "unknown" : "not-configured";
  const codingAi = ai;
  const codingProvider = generalTargets[0]?.provider;
  const codingModel = generalTargets[0]?.model;
  let imageAi: "unknown" | "not-configured" = "unknown";
  if (runtimeDb) {
    try { imageAi = await isImageGenerationConfigured(runtimeDb) ? "unknown" : "not-configured"; }
    catch { /* report unknown, not a failed live probe */ }
  }

  const ok = firebase === "reachable";
  return NextResponse.json({
    ok,
    firebase,
    cloudinary,
    ai,
    codingAi,
    ...(codingProvider ? { aiProvider: codingProvider, aiModel: codingModel, codingProvider, codingModel } : {}),
    imageAi,
    checkedAt,
  }, { status: ok ? 200 : 503 });
}
