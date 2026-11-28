"use client";

// =============================================================================
// Native shell — backend transport for the shared frontend.
//
// The shared components call the backend with same-origin relative URLs
// (`fetch("/api/rpc")`, `/api/auth/session`, `/api/ai` …), exactly like the
// website. Inside the app the page is served from `http://tauri.localhost`,
// so those requests never left the phone: Tauri answers unknown paths with the
// bundled `index.html`, every JSON parse failed, and screens crashed on the
// missing data (blank screen right after sign-in). Pointing fetch() at the real
// origin is not enough either — the backend sends no CORS headers.
//
// So, in the native shell only, requests for the app's own `/api/*` (or for
// the API origin directly) are sent through Tauri's HTTP plugin: a native
// request to the backend, with streaming bodies (chat) and AbortSignal intact.
// The `Origin` header is omitted, so the backend sees the same kind of request
// as its other bearer-token clients: the server accepts an Origin-less
// mutation only with `Authorization: Bearer <Firebase ID token>`. Most calls
// already carry it (rpc/ai); for the rest (session exchange, uploads …) the
// transport adds the signed-in user's token. The session cookie is kept in the
// plugin's own cookie jar.
// =============================================================================

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isNativeShell } from "@/native/native-bridge";

const DEFAULT_API_ORIGIN = "https://qorvyna.thamjj13.top";

/** The backend origin baked into the bundle (index.html meta, then build env). */
export function apiOrigin(doc: Document | null = typeof document !== "undefined" ? document : null): string {
  const fromMeta = doc?.querySelector('meta[name="qorvyna-api-origin"]')?.getAttribute("content")?.trim();
  const raw = fromMeta || process.env.NEXT_PUBLIC_APP_URL || DEFAULT_API_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_API_ORIGIN;
  }
}

/**
 * The backend URL a request should go to, or null when it is not a backend
 * request (bundled assets, Firebase/Google, Cloudinary … keep using fetch).
 */
export function backendUrlFor(input: RequestInfo | URL, pageUrl: string, origin: string): string | null {
  let url: URL;
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  const page = new URL(pageUrl);
  if (url.origin === page.origin && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
    return `${origin}${url.pathname}${url.search}`;
  }
  if (url.origin === origin) return url.href;
  return null;
}

type TransportWindow = Window & { __qorvynaApiTransport?: boolean };

/** Supplies `{ Authorization: "Bearer …" }` for the signed-in user, or `{}`. Must not throw. */
export type AuthHeaderSource = () => Promise<Record<string, string>>;

export interface NativeApiTransportOptions {
  win?: TransportWindow;
  authHeaders?: AuthHeaderSource;
  /** Test seams. */
  nativeShell?: () => boolean;
  nativeFetch?: typeof fetch;
}

/** Route backend fetches through the native HTTP plugin. No-op outside the app shell. */
export function installNativeApiTransport(options: NativeApiTransportOptions = {}): boolean {
  const win = options.win ?? (window as TransportWindow);
  const nativeFetch = options.nativeFetch ?? (tauriFetch as typeof fetch);
  if (!(options.nativeShell ?? isNativeShell)()) return false;
  if (win.__qorvynaApiTransport) return true;
  const browserFetch = win.fetch.bind(win);
  const origin = apiOrigin(win.document);

  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = backendUrlFor(input, win.location.href, origin);
    if (!target) return browserFetch(input, init);

    let requestInit: RequestInit = init ?? {};
    if (typeof Request !== "undefined" && input instanceof Request) {
      const hasBody = input.method !== "GET" && input.method !== "HEAD";
      requestInit = {
        method: input.method,
        headers: input.headers,
        body: hasBody ? await input.clone().arrayBuffer() : undefined,
        signal: input.signal,
        ...init,
      };
    }
    // Same-origin-only options mean nothing to a native request.
    const { credentials: _credentials, mode: _mode, ...rest } = requestInit;
    const headers = new Headers(rest.headers);
    // Empty Origin = omitted by the plugin (`unsafe-headers`), see the header comment.
    headers.set("Origin", "");
    if (!headers.has("Authorization") && options.authHeaders) {
      const auth = await options.authHeaders().catch(() => ({}) as Record<string, string>);
      for (const [name, value] of Object.entries(auth)) if (value) headers.set(name, value);
    }
    return nativeFetch(target, { ...rest, headers });
  }) as typeof fetch;

  win.__qorvynaApiTransport = true;
  return true;
}
