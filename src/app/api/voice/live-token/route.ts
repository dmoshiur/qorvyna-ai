import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { getSessionUser } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { VOICE_LANGUAGES } from "@/lib/voice-input";
import { liveConfig } from "@/lib/voice/live-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store" };
const schema = z.object({ language: z.string().refine((code) => VOICE_LANGUAGES.some((lang) => lang.code === code)).default("auto") }).strict();

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401, headers });
  // Explicit opt-in: provider model names/availability change independently of releases.
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_LIVE_MODEL?.trim();
  if (!apiKey || !model) return NextResponse.json({ error: "Live voice is not configured. Set GEMINI_API_KEY and GEMINI_LIVE_MODEL on the server." }, { status: 503, headers });
  if (Number(req.headers.get("content-length")) > 1024) return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413, headers });
  const raw = await req.text();
  if (raw.length > 1024) return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413, headers });
  const body = schema.safeParse(await Promise.resolve().then(() => JSON.parse(raw)).catch(() => null));
  if (!body.success) return NextResponse.json({ error: "INVALID_LANGUAGE" }, { status: 400, headers });
  try {
    // Shared fleet-wide quota. Store only counters, never tokens or media.
    const ref = adminDb().collection("voice_live_limits").doc(user.uid);
    const now = Date.now();
    const allowed = await adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const previous = snap.data();
      const inWindow = now - Number(previous?.window_start ?? 0) < 3600000;
      const count = inWindow ? Number(previous?.count ?? 0) : 0;
      if (now - Number(previous?.last_at ?? 0) < 20000 || count >= 12) return false;
      tx.set(ref, { window_start: inWindow ? previous!.window_start : now, last_at: now, count: count + 1 });
      return true;
    });
    if (!allowed) return NextResponse.json({ error: "Too many live sessions. Wait before trying again (12 starts per hour)." }, { status: 429, headers: { ...headers, "Retry-After": "60" } });
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha", timeout: 20000 } });
    const config = liveConfig(body.data.language);
    const token = await ai.authTokens.create({ config: {
      uses: 1,
      newSessionExpireTime: new Date(now + 60000).toISOString(),
      expireTime: new Date(now + 10 * 60000).toISOString(),
      liveConnectConstraints: { model, config },
    } });
    if (!token.name) throw new Error("Missing ephemeral token");
    return NextResponse.json({ token: token.name, model, config, expiresAt: now + 10 * 60000 }, { headers });
  } catch {
    // Provider errors may include sensitive request data. Never echo or log it.
    return NextResponse.json({ error: "Could not start Gemini Live. Check the configured model, regional availability and provider quota." }, { status: 503, headers });
  }
}
