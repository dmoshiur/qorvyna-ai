import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { env, isGithubConfigured } from "@/lib/env";
import { saveGithubConnection } from "@/lib/server/github";
import { consumeGithubOAuthState } from "@/lib/server/github-oauth-state";
import { GithubOAuthConfigError, githubOAuthUrls, githubResultPath, githubReturnPath, githubOwnerBinding } from "@/lib/server/github-oauth-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

const OAUTH_COOKIES = ["matrix_github_oauth", "matrix_github_oauth_return", "matrix_github_oauth_owner", "matrix_github_oauth_mode"] as const;

function clearOauthCookies(response: NextResponse) {
  for (const name of OAUTH_COOKIES) {
    response.cookies.set(name, "", { maxAge: 0, path: "/api/github/callback" });
  }
}

function finish(origin: string, status: string, returnPath?: string, popupMode = false) {
  const fallbackHref = new URL(githubResultPath(returnPath ?? "", status), origin).toString();
  if (popupMode && /^[a-z0-9_-]{1,32}$/i.test(status)) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub Connected — QORVYNA AI</title></head><body style="font-family:system-ui,sans-serif;padding:24px;background:#0d0e11;color:#f4f4f6"><p>GitHub status: <strong>${status}</strong>. Closing window…</p><p><a href="${fallbackHref.replace(/"/g, "&quot;")}" style="color:#d4954b">Return to QORVYNA AI</a></p><script>(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"qorvyna:github-oauth",status:${JSON.stringify(status)}},${JSON.stringify(origin)});window.close();return;}}catch(e){}window.location.replace(${JSON.stringify(fallbackHref)});})();</script></body></html>`;
    const response = new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
    clearOauthCookies(response);
    return response;
  }
  const response = NextResponse.redirect(fallbackHref, 303);
  clearOauthCookies(response);
  return response;
}

export async function GET(req: NextRequest) {
  let urls: ReturnType<typeof githubOAuthUrls>;
  try { urls = githubOAuthUrls(req.url); }
  catch (error) {
    const code = error instanceof GithubOAuthConfigError ? error.code : "GITHUB_APP_URL_INVALID";
    return NextResponse.json({ error: code, detail: "Configure NEXT_PUBLIC_APP_URL and the matching GitHub OAuth callback URL for this HTTPS service." }, { status: 503 });
  }
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const denied = req.nextUrl.searchParams.has("error");
  // Visiting the callback directly is not an OAuth attempt. Never call the
  // token endpoint or claim that a GitHub connection was established.
  if (!code && !state && !denied) return finish(urls.origin, "invalid_callback");

  const expected = req.cookies.get("matrix_github_oauth")?.value ?? "";
  const popupMode = req.cookies.get("matrix_github_oauth_mode")?.value === "popup";
  if (!state || !expected || !sameState(expected, state)) return finish(urls.origin, "invalid-state", undefined, popupMode);
  const destination = githubReturnPath(req.cookies.get("matrix_github_oauth_return")?.value);
  if (!code && !denied) return finish(urls.origin, "invalid_callback", destination, popupMode);

  const user = await getSessionUser(req);
  if (!user) {
    const response = NextResponse.redirect(new URL("/login?next=/chat?mode=agent", urls.origin), 303);
    clearOauthCookies(response);
    return response;
  }
  if (!isGithubConfigured()) return finish(urls.origin, "not-configured", destination, popupMode);
  const ownerBinding = req.cookies.get("matrix_github_oauth_owner")?.value ?? "";
  if (!ownerBinding || !sameState(ownerBinding, githubOwnerBinding(state, user.uid, env.github.tokenEncryptionKey))) {
    return finish(urls.origin, "invalid-state", destination, popupMode);
  }

  try {
    if (!await consumeGithubOAuthState(state, user.uid)) return finish(urls.origin, "invalid-state", destination, popupMode);
    if (denied) return finish(urls.origin, "denied", destination, popupMode);
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.github.clientId,
        client_secret: env.github.clientSecret,
        code,
        redirect_uri: urls.callback,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = (await exchange.json()) as { access_token?: string; error?: string };
    if (!exchange.ok || !tokenData.access_token || tokenData.error) return finish(urls.origin, "denied", destination, popupMode);

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "QORVYNA-AI-Agent",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) return finish(urls.origin, "profile-failed", destination, popupMode);
    const profile = (await profileResponse.json()) as { login?: string; name?: string | null; avatar_url?: string | null };
    if (!profile.login) return finish(urls.origin, "profile-failed", destination, popupMode);

    await saveGithubConnection(user.uid, tokenData.access_token, {
      login: profile.login,
      name: profile.name,
      avatar_url: profile.avatar_url,
    });
    return finish(urls.origin, "connected", destination, popupMode);
  } catch {
    // Never log OAuth codes or access tokens.
    console.error("[QORVYNA] GitHub OAuth callback failed during exchange or persistence.");
    return finish(urls.origin, "failed", destination, popupMode);
  }
}
