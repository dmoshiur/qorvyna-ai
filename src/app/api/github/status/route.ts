import { NextRequest, NextResponse } from "next/server";
import { githubOAuthUrls, GithubOAuthConfigError } from "@/lib/server/github-oauth-url";
import { getSessionUser } from "@/lib/firebase/session";
import { isGithubConfigured } from "@/lib/env";
import {
  canStoreGithubTokens,
  deleteGithubConnection,
  verifyAndSaveGithubToken,
  verifyGithubConnectionStatus,
} from "@/lib/server/github";
import {
  auditGithub,
  githubErrorResponse,
  githubRateLimited,
  githubSaveTokenSchema,
  readGithubJson,
} from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let oauthConfigured = isGithubConfigured();
  let configError = oauthConfigured ? "" : "GITHUB_CREDENTIALS_MISSING";
  if (oauthConfigured) {
    try {
      githubOAuthUrls(req.url);
    } catch (error) {
      oauthConfigured = false;
      configError = error instanceof GithubOAuthConfigError ? error.code : "GITHUB_APP_URL_INVALID";
    }
  }

  if (!canStoreGithubTokens()) {
    return NextResponse.json(
      { configured: false, connected: false, configuration_error: "GITHUB_CREDENTIALS_MISSING" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const verified = await verifyGithubConnectionStatus(user.uid);
  if (verified.connected && verified.connection) {
    return NextResponse.json(
      {
        configured: true,
        oauthConfigured,
        connected: true,
        connection: verified.connection,
        ...(verified.upstreamDegraded ? { upstreamDegraded: true } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!oauthConfigured) {
    return NextResponse.json(
      { configured: false, connected: false, configuration_error: configError },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      configured: true,
      connected: false,
      connection: null,
      ...(verified.reauthorize ? { reauthorize: true } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Save & persist an encrypted Personal Access Token after live GitHub /user verification. */
export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "token_save")) {
    return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  }
  try {
    const parsed = githubSaveTokenSchema.safeParse(await readGithubJson(req));
    if (!parsed.success) throw new Error("GITHUB_TOKEN_INVALID");
    const connection = await verifyAndSaveGithubToken(user.uid, parsed.data.token);
    await auditGithub(user.uid, "token_save", "ok", connection.login);
    return NextResponse.json(
      {
        configured: true,
        connected: true,
        connection,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await auditGithub(user.uid, "token_save", "failed");
    return githubErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  await deleteGithubConnection(user.uid);
  await auditGithub(user.uid, "disconnect", "ok");
  return NextResponse.json({ disconnected: true }, { headers: { "Cache-Control": "no-store" } });
}
