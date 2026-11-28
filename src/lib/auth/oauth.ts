"use client";

// =============================================================================
// Google sign-in for /login, /register, and Settings linking.
//
// Facebook sign-in was removed from the product (sign-in UI, provider
// construction and Settings linking). Google and email/password remain, and
// existing Firebase accounts — including any that once linked Facebook — keep
// working: nothing about the account store changes.
//
// TRANSPORT: popup OAuth (`signInWithPopup` / `linkWithPopup`).
//   startOAuthSignIn() → signInWithPopup(auth, provider)
//   startOAuthLink()   → linkWithPopup(user, provider)
//
// Cross-origin redirect OAuth breaks in modern browsers whenever `authDomain`
// (`*.firebaseapp.com`) differs from the site origin (`qorvyna.thamjj13.top`)
// because third-party storage partitioning drops the redirect auth event.
// `signInWithPopup()` returns the `UserCredential` directly, updates the
// shared Firebase `Auth` instance so `onAuthStateChanged` fires reliably, and
// avoids cross-domain redirect state loss.
//
// Two separate steps are always reported separately:
//   • the Firebase/OAuth step → status "cancelled" | "error"
//   • the QORVYNA session step → status "session-failed"
// A minted Firebase user is NEVER labelled "Google failed".
// =============================================================================

import {
  GoogleAuthProvider,
  getAdditionalUserInfo,
  linkWithCredential,
  linkWithPopup,
  linkWithRedirect,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
  type AuthProvider,
  type User,
  type UserCredential,
} from "firebase/auth";
import { fbAuth } from "@/lib/firebase/client";
import { describeAuthError } from "@/lib/firebase/auth-errors";
import { mintSessionCookie, type SessionProfileSummary } from "@/lib/client/api";
import { postAuthDestination } from "@/lib/routing";
import { logAuthDiagnostic, logAuthEvent } from "@/lib/auth/diagnostics";

/** The only federated identity provider QORVYNA offers. */
export type OAuthProviderId = "google";

export type OAuthOk = {
  status: "ok";
  uid: string;
  onboardingComplete: boolean;
  provider: OAuthProviderId;
  isNewUser: boolean;
  /**
   * "link" means an already signed-in user attached a provider (Settings →
   * Linked sign-in). It must never trigger a post-login navigation.
   */
  operation: "signIn" | "link";
  profileLoaded?: boolean;
  profile?: SessionProfileSummary | null;
};
export type OAuthResult =
  | OAuthOk
  | { status: "cancelled"; message: string; provider: OAuthProviderId }
  | { status: "session-failed"; message: string; provider: OAuthProviderId }
  | { status: "redirecting"; message: string; provider: OAuthProviderId }
  | { status: "error"; message: string; provider?: OAuthProviderId };

const SESSION_FAILED =
  "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.";

const REDIRECTING_MESSAGE =
  "Opening Google sign-in — you will return here automatically when it finishes.";

const BAD_ORIGIN_FAILED =
  "You're signed in, but this domain is not allowed to create the QORVYNA session. An administrator must include this hostname in NEXT_PUBLIC_APP_URL (or QORVYNA_ALLOWED_ORIGINS) and redeploy — your account is fine.";

// -----------------------------------------------------------------------------
// Post-login destination storage (best-effort only; never blocks auth)
// -----------------------------------------------------------------------------

const K_NEXT = "qorvyna.oauth.next";
const DEST_MAX_AGE_MS = 10 * 60 * 1000;

function store(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled — the flow continues without the hint */
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function rememberPostLoginPath(next: string | null | undefined): void {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return;
  writeJson(K_NEXT, { path: next, at: Date.now() });
}

export function rememberedPostLoginPath(): string | null {
  const saved = readJson<{ path?: unknown; at?: unknown }>(K_NEXT);
  if (!saved || typeof saved.path !== "string" || typeof saved.at !== "number") return null;
  if (Date.now() - saved.at > DEST_MAX_AGE_MS) {
    remove(K_NEXT);
    return null;
  }
  return saved.path.startsWith("/") && !saved.path.startsWith("//") ? saved.path : null;
}

function clearRememberedPostLoginPath(): void {
  remove(K_NEXT);
}

export function clearOAuthFlowMarkers(): void {
  clearRememberedPostLoginPath();
}

export function postAuthPath(onboardingComplete: boolean, next?: string | null): string {
  return postAuthDestination(next ?? rememberedPostLoginPath());
}

// -----------------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------------

const CANCELLED_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
  "auth/web-context-cancelled",
]);

/** The user closed/cancelled the popup before completing authentication. */
export function isOAuthCancelled(err: unknown): boolean {
  return CANCELLED_CODES.has(errorCode(err));
}

/**
 * True when the shared frontend runs inside the QORVYNA desktop/Android shell
 * (Tauri v2 exposes these globals to the bundled frontend). In the Android
 * WebView there is no popup window: `signInWithPopup` can never complete, so
 * the Google flow falls back to a full-page redirect handled by Firebase's
 * own resolver (`browserPopupRedirectResolver` is registered at
 * `initializeAuth` in src/lib/firebase/client.ts, so the result is consumed
 * automatically on return — no manual `getRedirectResult` call anywhere).
 */
export function isQorvynaWebView(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const host = window as typeof window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
    return Boolean(host.__TAURI__) || Boolean(host.__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Android app: native Google account picker
//
// Google refuses its OAuth pages inside an embedded WebView, so in the Android
// app the popup/redirect flow opened a detached window that never listed the
// phone's Google accounts. There, sign-in uses Android Credential Manager
// instead (Kotlin QorvynaGoogleSignIn via the `qorvyna_google_sign_in`
// command): the system sheet with the device's accounts returns a Google ID
// token, which Firebase turns into the same user as on the website.
// -----------------------------------------------------------------------------

/** Web OAuth client the ID token is issued for (baked into the app bundle). */
const GOOGLE_WEB_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "";

const NATIVE_GOOGLE_NOT_REGISTERED =
  "Google sign-in isn't available in this app build yet: Google did not accept the app's signing certificate. " +
  "An administrator must add the app's SHA-1 / SHA-256 fingerprints to the Android app in the Firebase console " +
  "(see signing/README.md). You can sign in with email and password meanwhile.";

/** True in the Android app shell when the native picker can be used. */
export function canUseNativeGoogleSignIn(): boolean {
  if (!isQorvynaWebView() || !GOOGLE_WEB_CLIENT_ID) return false;
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Show the native account sheet; resolves the Google ID token. Errors carry `native/<CODE>`. */
async function nativeGoogleIdToken(): Promise<string> {
  const host = window as typeof window & {
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
  };
  const invoke = host.__TAURI_INTERNALS__?.invoke ?? host.__TAURI__?.core?.invoke;
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code: `native/${code}` });
  if (!invoke) throw fail("GOOGLE_FAILED", "The app bridge is not available.");
  let result: unknown;
  try {
    result = await invoke("qorvyna_google_sign_in", { webClientId: GOOGLE_WEB_CLIENT_ID });
  } catch (err) {
    // Rust returns Kotlin rejections as "...[CODE] - message".
    const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
    const code = /\[(CANCELLED|NO_ACCOUNT|GOOGLE_FAILED)\]/.exec(text)?.[1] ?? "GOOGLE_FAILED";
    throw fail(code, text);
  }
  const idToken = (result as { idToken?: unknown } | null)?.idToken;
  if (typeof idToken !== "string" || !idToken) throw fail("GOOGLE_FAILED", "Google did not return an ID token.");
  return idToken;
}

/** User-facing text for a native Google sign-in failure. */
export function describeNativeGoogleFailure(err: unknown): string {
  const code = errorCode(err);
  const text = errorText(err);
  if (code === "native/CANCELLED") return "Google sign-in was cancelled.";
  if (code === "native/NO_ACCOUNT" || text.includes("28444") || text.includes("developer console")) {
    return code === "native/NO_ACCOUNT"
      ? "No Google account could be used. Add one in Android Settings → Accounts. If your accounts are already there: " +
          NATIVE_GOOGLE_NOT_REGISTERED.charAt(0).toLowerCase() +
          NATIVE_GOOGLE_NOT_REGISTERED.slice(1)
      : NATIVE_GOOGLE_NOT_REGISTERED;
  }
  if (code.startsWith("native/")) {
    const detail = err instanceof Error ? err.message : "";
    return `Google sign-in failed on this device${detail ? ` (${detail})` : ""}. You can sign in with email and password meanwhile.`;
  }
  return describeOAuthFailure(err, "google");
}

async function startNativeGoogleSignIn(auth: Auth, provider: OAuthProviderId): Promise<OAuthResult> {
  let cred: UserCredential;
  try {
    const idToken = await nativeGoogleIdToken();
    cred = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  } catch (err) {
    const cancelled = errorCode(err) === "native/CANCELLED";
    logAuthEvent(cancelled ? "POPUP_SIGN_IN_COMPLETED" : "AUTH_POPUP_ERROR", {
      stage: "popup-result",
      method: "google",
      provider,
      error: err,
      detail: { outcome: cancelled ? "cancelled" : "failed", transport: "android-credential-manager" },
    });
    return cancelled
      ? { status: "cancelled", message: describeNativeGoogleFailure(err), provider }
      : { status: "error", message: describeNativeGoogleFailure(err), provider };
  }
  logAuthEvent("POPUP_SIGN_IN_COMPLETED", {
    stage: "popup-result",
    method: "google",
    provider,
    detail: { outcome: "credential_received", transport: "android-credential-manager", hasUser: Boolean(cred.user?.uid) },
  });
  await confirmSharedAuthState(auth, cred.user.uid);
  return finishSignIn(cred, provider);
}

async function startNativeGoogleLink(user: User, provider: OAuthProviderId): Promise<OAuthResult> {
  let cred: UserCredential;
  try {
    cred = await linkWithCredential(user, GoogleAuthProvider.credential(await nativeGoogleIdToken()));
  } catch (err) {
    const cancelled = errorCode(err) === "native/CANCELLED";
    logAuthEvent("AUTH_POPUP_ERROR", { stage: "link-result", method: "link", provider, error: err });
    return cancelled
      ? { status: "cancelled", message: describeNativeGoogleFailure(err), provider }
      : { status: "error", message: describeNativeGoogleFailure(err), provider };
  }
  try {
    await completeAuthenticatedSession(cred.user, { forceRefresh: true });
  } catch {
    /* the link succeeded in Firebase; keep the active session */
  }
  return { status: "ok", uid: cred.user.uid, onboardingComplete: true, provider, isNewUser: false, operation: "link" };
}

function isStorageBlocked(err: unknown): boolean {
  const code = errorCode(err);
  const text = errorText(err);
  return (
    code === "auth/web-storage-unsupported" ||
    code === "auth/third-party-cookie-blocked" ||
    text.includes("storage-partitioned")
  );
}

export function describeOAuthFailure(err: unknown, provider: OAuthProviderId): string {
  const code = errorCode(err);
  const label = provider === "google" ? "Google" : "this provider";

  if (code === "BAD_ORIGIN") return BAD_ORIGIN_FAILED;
  if (code === "auth/popup-blocked") {
    return "Your browser blocked the sign-in popup. Allow popups for this site and try again, or sign in with email and password.";
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return "The sign-in popup was closed before finishing. Please try again and keep the popup open until sign-in completes.";
  }
  if (code === "auth/account-exists-with-different-credential") {
    return "An account with this email already exists. Sign in with email and password, then link Google in Settings.";
  }
  if (code === "auth/network-request-failed") {
    return "Network problem — check your internet connection and try again.";
  }
  if (isStorageBlocked(err)) {
    return "Your browser blocked the storage this sign-in needs. Allow cookies/site data for this domain (or leave private browsing) and try again.";
  }
  if (code === "auth/operation-not-supported-in-this-environment") {
    return `${label} sign-in can't run inside this in-app browser. Open QORVYNA in Chrome/Safari, or sign in with email instead.`;
  }
  if (code === "auth/unauthorized-domain") {
    return "Server setup problem — this domain isn't approved for sign-in yet (Firebase console → Authentication → Settings → Authorized domains).";
  }
  if (code === "auth/operation-not-allowed") {
    return "Server setup problem — this sign-in method isn't enabled in Firebase (console → Authentication → Sign-in method).";
  }
  const mapped = describeAuthError(err, "");
  if (mapped) return mapped;
  return `We couldn't finish ${label} sign-in. Please try again or use email instead.`;
}

// -----------------------------------------------------------------------------
// Session establishment
// -----------------------------------------------------------------------------

/** Exchange the signed-in user's ID token for the httpOnly `__session` cookie. */
export async function completeAuthenticatedSession(
  userOverride?: User | null,
  options?: { forceRefresh?: boolean },
): Promise<{
  uid: string;
  onboardingComplete: boolean;
  profileLoaded?: boolean;
  profile?: SessionProfileSummary | null;
}> {
  const data =
    userOverride || options
      ? await mintSessionCookie(userOverride, options)
      : await mintSessionCookie();
  if (typeof fetch === "function") {
    void fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "record_security_event", event_type: "login", metadata: {} }),
    }).catch(() => {
      /* best-effort audit only */
    });
  }
  return {
    uid: data.uid,
    onboardingComplete: data.onboarding_complete,
    profileLoaded: data.profile_loaded,
    profile: data.profile,
  };
}

function sessionFailureResult(err: unknown, provider: OAuthProviderId): OAuthResult {
  const code = errorCode(err);
  const message = code === "BAD_ORIGIN" ? BAD_ORIGIN_FAILED : SESSION_FAILED;
  logAuthDiagnostic({ stage: "session-mint", method: provider, provider, error: err, detail: { code } });
  return { status: "session-failed", message, provider };
}

// -----------------------------------------------------------------------------
// Public flows
// -----------------------------------------------------------------------------

/**
 * The Firebase provider for an id. Only Google exists: any other id is
 * rejected by the type system, and a stale caller passing "facebook" gets a
 * clear error instead of silently starting a Facebook popup.
 */
function makeProvider(provider: OAuthProviderId): AuthProvider {
  if (provider !== "google") {
    throw new Error("UNSUPPORTED_PROVIDER");
  }
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  p.addScope("email");
  p.addScope("profile");
  return p;
}

/**
 * Let the shared Firebase Auth instance flush `authStateReady()` after a popup
 * completes so `onAuthStateChanged` listeners (such as `attachStateMirror`)
 * observe the new user cleanly before backend profile/session setup runs.
 */
async function confirmSharedAuthState(auth: Auth, uid: string): Promise<void> {
  if (auth.currentUser?.uid === uid) return;
  if (typeof (auth as { authStateReady?: () => Promise<void> }).authStateReady === "function") {
    await Promise.race([
      (auth as { authStateReady: () => Promise<void> }).authStateReady(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]).catch(() => {
      /* continue with verified cred.user */
    });
  }
}

/**
 * Sign in via Firebase popup (`signInWithPopup`).
 * Important: calls `signInWithPopup` without any prior `await` so browsers
 * preserve the user-click gesture and do not trigger `auth/popup-blocked`.
 */
export async function startOAuthSignIn(
  provider: OAuthProviderId,
  options: { next?: string | null } = {},
): Promise<OAuthResult> {
  const auth = fbAuth();
  rememberPostLoginPath(options.next);
  logAuthEvent("POPUP_SIGN_IN_STARTED", {
    stage: "popup-start",
    method: "popup",
    provider,
    detail: { next: options.next ?? "" },
  });

  // Android app: the system account sheet instead of a WebView popup.
  if (provider === "google" && canUseNativeGoogleSignIn()) return startNativeGoogleSignIn(auth, provider);

  let cred: UserCredential;
  try {
    cred = await signInWithPopup(auth, makeProvider(provider));
  } catch (err) {
    if (isOAuthCancelled(err)) {
      logAuthEvent("POPUP_SIGN_IN_COMPLETED", {
        stage: "popup-result",
        method: "popup",
        provider,
        error: err,
        detail: { outcome: "cancelled" },
      });
      return { status: "cancelled", message: describeOAuthFailure(err, provider), provider };
    }
    // QORVYNA's Android/desktop shell has no popup window: fall back to a
    // full-page redirect (consumed automatically by the registered resolver
    // when Google returns the user to the app).
    if (isQorvynaWebView()) {
      logAuthEvent("AUTH_POPUP_ERROR", {
        stage: "popup-result",
        method: "webview-redirect-fallback",
        provider,
        error: err,
        detail: { outcome: "fallback_redirect" },
      });
      try {
        await signInWithRedirect(auth, makeProvider(provider));
        return { status: "redirecting", message: REDIRECTING_MESSAGE, provider };
      } catch (redirectErr) {
        logAuthEvent("AUTH_POPUP_ERROR", {
          stage: "redirect-result",
          method: "webview-redirect-fallback",
          provider,
          error: redirectErr,
          detail: { outcome: "failed" },
        });
        return { status: "error", message: describeOAuthFailure(redirectErr, provider), provider };
      }
    }
    logAuthEvent("AUTH_POPUP_ERROR", {
      stage: "popup-result",
      method: "popup",
      provider,
      error: err,
      detail: { outcome: "failed" },
    });
    return { status: "error", message: describeOAuthFailure(err, provider), provider };
  }

  if (!cred || !cred.user || !cred.user.uid) {
    const missingErr = new Error("Firebase popup did not return an authenticated user.");
    logAuthEvent("AUTH_POPUP_ERROR", {
      stage: "popup-result",
      method: "popup",
      provider,
      error: missingErr,
      detail: { reason: "missing_credential_user" },
    });
    return { status: "error", message: describeOAuthFailure(missingErr, provider), provider };
  }

  const resolvedProvider = providerFromCredential(cred) ?? provider;
  logAuthEvent("POPUP_SIGN_IN_COMPLETED", {
    stage: "popup-result",
    method: "popup",
    provider: resolvedProvider,
    detail: {
      outcome: "credential_received",
      operationType: cred.operationType ?? "signIn",
      hasUser: true,
    },
  });
  logAuthEvent("AUTH_USER_DETECTED", {
    stage: "auth-state",
    method: "popup",
    provider: resolvedProvider,
    detail: { source: "popup_credential", uidPresent: true },
  });

  await confirmSharedAuthState(auth, cred.user.uid);
  return finishSignIn(cred, resolvedProvider);
}

/**
 * Link an OAuth provider to the CURRENT signed-in user via `linkWithPopup`
 * (Settings → Linked sign-in). Never navigates away from Settings.
 */
export async function startOAuthLink(provider: OAuthProviderId): Promise<OAuthResult> {
  const user = fbAuth().currentUser;
  if (!user) return { status: "error", message: "Sign in first, then link this provider.", provider };

  logAuthEvent("POPUP_SIGN_IN_STARTED", { stage: "link-start", method: "link", provider });
  // Android app: link through the native account sheet as well.
  if (provider === "google" && canUseNativeGoogleSignIn()) return startNativeGoogleLink(user, provider);

  let cred: UserCredential;
  try {
    cred = await linkWithPopup(user, makeProvider(provider));
  } catch (err) {
    if (isOAuthCancelled(err)) {
      logAuthEvent("POPUP_SIGN_IN_COMPLETED", {
        stage: "link-result",
        method: "link",
        provider,
        error: err,
        detail: { outcome: "cancelled" },
      });
      return { status: "cancelled", message: describeOAuthFailure(err, provider), provider };
    }
    // Same WebView constraint as sign-in: no popup window in the app shell,
    // so linking falls back to the full-page redirect transport as well.
    if (isQorvynaWebView()) {
      logAuthEvent("AUTH_POPUP_ERROR", { stage: "link-result", method: "webview-redirect-fallback", provider, error: err });
      try {
        await linkWithRedirect(user, makeProvider(provider));
        return { status: "redirecting", message: REDIRECTING_MESSAGE, provider };
      } catch (redirectErr) {
        logAuthEvent("AUTH_POPUP_ERROR", { stage: "redirect-result", method: "webview-redirect-fallback", provider, error: redirectErr });
        return { status: "error", message: describeOAuthFailure(redirectErr, provider), provider };
      }
    }
    logAuthEvent("AUTH_POPUP_ERROR", { stage: "link-result", method: "link", provider, error: err });
    return { status: "error", message: describeOAuthFailure(err, provider), provider };
  }

  if (!cred || !cred.user || !cred.user.uid) {
    const missingErr = new Error("Linking did not return an authenticated user.");
    logAuthEvent("AUTH_POPUP_ERROR", { stage: "link-result", method: "link", provider, error: missingErr });
    return { status: "error", message: describeOAuthFailure(missingErr, provider), provider };
  }

  try {
    await completeAuthenticatedSession(cred.user, { forceRefresh: true });
  } catch {
    /* the link succeeded in Firebase; keep the active session */
  }
  return {
    status: "ok",
    uid: cred.user.uid,
    onboardingComplete: true,
    provider,
    isNewUser: false,
    operation: "link",
  };
}

async function finishSignIn(cred: UserCredential, provider: OAuthProviderId): Promise<OAuthResult> {
  const isNewUser = (() => {
    try {
      return getAdditionalUserInfo(cred)?.isNewUser === true;
    } catch {
      return false;
    }
  })();

  try {
    const session = await completeAuthenticatedSession(cred.user);
    if (session.profileLoaded === false) {
      throw Object.assign(new Error("User profile could not be loaded."), { code: "PROFILE_LOAD_FAILED" });
    }
    clearRememberedPostLoginPath();
    return {
      status: "ok",
      uid: session.uid,
      onboardingComplete: session.onboardingComplete,
      provider,
      isNewUser,
      operation: "signIn",
      profileLoaded: session.profileLoaded,
      profile: session.profile,
    };
  } catch (err) {
    return sessionFailureResult(err, provider);
  }
}

function providerFromCredential(cred: UserCredential): OAuthProviderId | null {
  const id = cred.providerId ?? cred.user?.providerData?.[0]?.providerId ?? "";
  if (id.includes("google")) return "google";
  return null;
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  return String((err as { code?: unknown }).code ?? "");
}

function errorText(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as { code?: unknown; message?: unknown };
  return `${e.code ?? ""} ${e.message ?? ""}`.toLowerCase();
}
