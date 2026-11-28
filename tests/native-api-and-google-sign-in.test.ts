// =============================================================================
// Android app: sign-in and post-login screens.
//   1. After signing in, the workspace went blank. The app is served from
//      http://tauri.localhost, so the shared frontend's relative `/api/*`
//      calls were answered with the bundled index.html (never reaching the
//      backend). A component then read a field of the HTML-shaped reply and
//      the React tree unmounted. Fix: native HTTP transport for backend calls
//      (Tauri HTTP plugin, Origin omitted + Bearer, as the server expects of
//      native clients), crash guards and error boundaries.
//   2. "Continue with Google" opened a detached browser window without the
//      phone's accounts. Fix: Android Credential Manager account sheet → Google
//      ID token → Firebase signInWithCredential.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { apiOrigin, backendUrlFor, installNativeApiTransport } from "@/native/api-transport";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const API = "https://qorvyna.thamjj13.top";
const PAGE = "http://tauri.localhost/chat";

describe("backendUrlFor", () => {
  it("sends the app's own /api/* calls to the backend, keeping path and query", () => {
    expect(backendUrlFor("/api/rpc", PAGE, API)).toBe(`${API}/api/rpc`);
    expect(backendUrlFor("/api/models?x=1", PAGE, API)).toBe(`${API}/api/models?x=1`);
    expect(backendUrlFor(new URL("http://tauri.localhost/api/auth/session"), PAGE, API)).toBe(`${API}/api/auth/session`);
    expect(backendUrlFor(`${API}/api/ai`, PAGE, API)).toBe(`${API}/api/ai`);
  });

  it("leaves bundled files and third-party services on the normal fetch", () => {
    expect(backendUrlFor("/app.js", PAGE, API)).toBeNull();
    expect(backendUrlFor("/apix/thing", PAGE, API)).toBeNull();
    expect(backendUrlFor("https://identitytoolkit.googleapis.com/v1/accounts", PAGE, API)).toBeNull();
    expect(backendUrlFor("https://api.cloudinary.com/v1_1/x/upload", PAGE, API)).toBeNull();
  });
});

describe("apiOrigin", () => {
  it("prefers the origin baked into index.html", () => {
    const doc = {
      querySelector: () => ({ getAttribute: () => "https://example.test/some/path" }),
    } as unknown as Document;
    expect(apiOrigin(doc)).toBe("https://example.test");
  });
  it("falls back to the default backend", () => {
    expect(apiOrigin(null)).toMatch(/^https:\/\//);
  });
});

function fakeWindow() {
  const browserFetch = vi.fn(async () => new Response("browser"));
  const win = {
    fetch: browserFetch,
    location: { href: PAGE },
    document: { querySelector: () => ({ getAttribute: () => API }) },
  } as unknown as Window & { __qorvynaApiTransport?: boolean };
  return { win, browserFetch };
}

describe("installNativeApiTransport", () => {
  it("does nothing outside the app shell (website unchanged)", () => {
    const { win, browserFetch } = fakeWindow();
    expect(installNativeApiTransport({ win, nativeShell: () => false })).toBe(false);
    expect(win.fetch).toBe(browserFetch);
  });

  it("routes backend calls natively without Origin, adding the user's bearer when missing", async () => {
    const { win, browserFetch } = fakeWindow();
    const nativeFetch = vi.fn(async () => new Response("{}"));
    const authHeaders = vi.fn(async () => ({ Authorization: "Bearer user-token" }));
    expect(
      installNativeApiTransport({ win, nativeShell: () => true, nativeFetch: nativeFetch as typeof fetch, authHeaders }),
    ).toBe(true);

    await win.fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = nativeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/auth/session`);
    const headers = new Headers(init.headers);
    expect(headers.get("Origin")).toBe(""); // empty = removed by the plugin (`unsafe-headers`)
    expect(headers.get("Authorization")).toBe("Bearer user-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init).not.toHaveProperty("credentials");
    expect(init.body).toBe("{}");

    // An explicit bearer (rpc / ai) is kept as is.
    await win.fetch("/api/rpc", { method: "POST", headers: { Authorization: "Bearer explicit" } });
    expect(new Headers((nativeFetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).get("Authorization")).toBe(
      "Bearer explicit",
    );
    expect(authHeaders).toHaveBeenCalledTimes(1);

    // Bundled assets still use the WebView's fetch.
    await win.fetch("/favicon.svg");
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it("installs once", () => {
    const { win } = fakeWindow();
    installNativeApiTransport({ win, nativeShell: () => true, nativeFetch: vi.fn() as unknown as typeof fetch });
    const wrapped = win.fetch;
    installNativeApiTransport({ win, nativeShell: () => true, nativeFetch: vi.fn() as unknown as typeof fetch });
    expect(win.fetch).toBe(wrapped);
  });
});

describe("native wiring (compiled only by the Android CI build)", () => {
  it("installs the transport, with the bearer source, before rendering", () => {
    const entry = read("src/native/client/entry.tsx");
    const install = entry.indexOf("installNativeApiTransport({ authHeaders");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(entry.indexOf("createRoot("));
  });

  it("registers the HTTP plugin scoped to the backend origin", () => {
    expect(read("src-tauri/Cargo.toml")).toMatch(/tauri-plugin-http = \{[^}]*"unsafe-headers"/);
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toContain("tauri_plugin_http::init()");
    expect(lib).toContain("native::qorvyna_google_sign_in");
    const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
    const http = capability.permissions.find((entry: { identifier?: string }) => entry?.identifier === "http:default");
    expect(http.allow).toContainEqual({ url: `${API}/*` });
    const csp = JSON.parse(read("src-tauri/tauri.conf.json")).app.security.csp["connect-src"] as string;
    expect(csp).toContain("ipc:");
    expect(csp).toContain("http://ipc.localhost");
  });

  it("bridges the Kotlin account sheet to a Rust command", () => {
    expect(read("src-tauri/src/native.rs")).toMatch(/pub async fn qorvyna_google_sign_in\(\s*web_client_id: String/);
    expect(read("src-tauri/src/assistant.rs")).toContain('"googleSignIn"');
    const plugin = read("src-tauri/android/app/src/main/kotlin/ai/matrix/desktop/AssistantPlugin.kt");
    expect(plugin).toMatch(/@Command\s+fun googleSignIn\(/);
    const signIn = read("src-tauri/android/app/src/main/kotlin/ai/matrix/desktop/QorvynaGoogleSignIn.kt");
    expect(signIn).toContain("GetGoogleIdOption");
    expect(signIn).toContain("setFilterByAuthorizedAccounts(false)");
    for (const code of ["CANCELLED", "NO_ACCOUNT", "GOOGLE_FAILED"]) expect(signIn).toContain(`"${code}"`);
  });

  it("adds the Credential Manager libraries and R8 rules to the generated Android project", () => {
    const patch = read("scripts/native/patch-android-manifest.mjs");
    for (const dep of [
      "androidx.credentials:credentials:",
      "androidx.credentials:credentials-play-services-auth:",
      "com.google.android.libraries.identity.googleid:googleid:",
      "org.jetbrains.kotlinx:kotlinx-coroutines-android:",
    ]) {
      expect(patch).toContain(dep);
    }
    expect(patch).toContain("-keep class androidx.credentials.playservices.**");
  });

  it("bakes the Web OAuth client ID into the bundle", () => {
    const build = read("scripts/native/build-native-frontend.mjs");
    expect(build).toContain('"process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID"');
    expect(build).toContain("client_type === 3");
  });

  it("guards the mirror banner against malformed replies and isolates screen crashes", () => {
    const banner = read("src/components/family/mirror-banner.tsx");
    expect(banner).toContain("Array.isArray(reply?.active_sessions)");
    const app = read("src/native/native-app.tsx");
    expect(app).toContain("class NativeErrorBoundary");
    expect(app).toMatch(/<NativeErrorBoundary scope="app">\s*<NativeWorkspace \/>/);
    expect(app).toMatch(/<NativeErrorBoundary scope="screen" resetKey=\{pathname\}>/);
  });
});
