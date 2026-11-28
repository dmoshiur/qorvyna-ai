// =============================================================================
// Android app: "Continue with Google" uses the phone's account sheet
// (Credential Manager via the `qorvyna_google_sign_in` command) and signs in to
// Firebase with the returned Google ID token — no detached browser window.
// The website (and any shell without the client ID) keeps the popup flow.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  signInWithCredential: vi.fn(),
  linkWithCredential: vi.fn(),
  credential: vi.fn((idToken: string) => ({ providerId: "google.com", idToken })),
  getAdditionalUserInfo: vi.fn(),
  mintSessionCookie: vi.fn(),
  invoke: vi.fn(),
  state: { currentUser: null as null | { uid: string; providerData: { providerId: string }[] } },
}));

vi.mock("firebase/auth", () => {
  class GoogleAuthProvider {
    static credential = mocks.credential;
    setCustomParameters() {}
    addScope() {}
  }
  return {
    GoogleAuthProvider,
    FacebookAuthProvider: class {
      addScope() {}
    },
    signInWithPopup: mocks.signInWithPopup,
    linkWithPopup: vi.fn(),
    signInWithRedirect: vi.fn(),
    linkWithRedirect: vi.fn(),
    signInWithCredential: mocks.signInWithCredential,
    linkWithCredential: mocks.linkWithCredential,
    getAdditionalUserInfo: mocks.getAdditionalUserInfo,
  };
});

vi.mock("@/lib/firebase/client", () => ({
  fbAuth: () => ({
    get currentUser() {
      return mocks.state.currentUser;
    },
    authStateReady: async () => {},
  }),
}));

vi.mock("@/lib/client/api", () => ({ mintSessionCookie: mocks.mintSessionCookie }));

const USER = { uid: "uid-g", providerData: [{ providerId: "google.com" }] };
const CRED = { user: USER, providerId: "google.com", operationType: "signIn" as const };

function installAppWindow(withBridge = true) {
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hostname: "tauri.localhost", origin: "http://tauri.localhost" },
    isSecureContext: true,
    ...(withBridge ? { __TAURI_INTERNALS__: { invoke: mocks.invoke } } : {}),
  };
}

async function loadOAuth(clientId = "web-client.apps.googleusercontent.com") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID = clientId;
  return import("@/lib/auth/oauth");
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  installAppWindow();
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36" });
  mocks.state.currentUser = null;
  mocks.invoke.mockResolvedValue({ idToken: "google-id-token", email: "one@example.com" });
  mocks.signInWithCredential.mockImplementation(async () => {
    mocks.state.currentUser = USER;
    return CRED;
  });
  mocks.getAdditionalUserInfo.mockReturnValue({ isNewUser: false });
  mocks.mintSessionCookie.mockResolvedValue({ ok: true, uid: "uid-g", onboarding_complete: true, profile_loaded: true });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  info.mockRestore();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID;
});

describe("native Google sign-in (Android app)", () => {
  it("uses the device account sheet and signs in with the ID token — no popup", async () => {
    const { startOAuthSignIn, canUseNativeGoogleSignIn } = await loadOAuth();
    expect(canUseNativeGoogleSignIn()).toBe(true);
    const result = await startOAuthSignIn("google");
    expect(mocks.invoke).toHaveBeenCalledWith("qorvyna_google_sign_in", {
      webClientId: "web-client.apps.googleusercontent.com",
    });
    expect(mocks.credential).toHaveBeenCalledWith("google-id-token");
    expect(mocks.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.mintSessionCookie).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", uid: "uid-g", provider: "google" });
  });

  it("reports a dismissed sheet as cancelled", async () => {
    mocks.invoke.mockRejectedValue("[CANCELLED] - The account picker was closed.");
    const { startOAuthSignIn } = await loadOAuth();
    const result = await startOAuthSignIn("google");
    expect(result).toEqual({ status: "cancelled", message: "Google sign-in was cancelled.", provider: "google" });
    expect(mocks.signInWithCredential).not.toHaveBeenCalled();
  });

  it("explains an unregistered signing certificate instead of a generic failure", async () => {
    mocks.invoke.mockRejectedValue("[GOOGLE_FAILED] - 28444: Developer console is not set up correctly.");
    const { startOAuthSignIn } = await loadOAuth();
    const result = await startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect((result as { message: string }).message).toContain("SHA-1 / SHA-256");
  });

  it("links Google to the signed-in account through the sheet as well", async () => {
    mocks.state.currentUser = { uid: "uid-g", providerData: [{ providerId: "password" }] };
    mocks.linkWithCredential.mockResolvedValue({ ...CRED, operationType: "link" });
    const { startOAuthLink } = await loadOAuth();
    const result = await startOAuthLink("google");
    expect(mocks.linkWithCredential).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", operation: "link" });
  });

  it("keeps the popup flow on the website, and in shells without the client ID", async () => {
    installAppWindow(false);
    let oauth = await loadOAuth();
    expect(oauth.canUseNativeGoogleSignIn()).toBe(false);
    installAppWindow(true);
    oauth = await loadOAuth("");
    expect(oauth.canUseNativeGoogleSignIn()).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36" });
    oauth = await loadOAuth();
    expect(oauth.canUseNativeGoogleSignIn()).toBe(false);
  });
});
