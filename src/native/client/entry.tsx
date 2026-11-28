"use client";

// Standalone entry for the bundled Tauri frontend.
// Built by scripts/native/build-native-frontend.mjs into public/native/index.html
// so the app ships its own assets instead of loading a remote URL.
import { createRoot } from "react-dom/client";
// The stylesheet is compiled by Tailwind in scripts/native/build-native-frontend.mjs
// and loaded by the generated index.html, so the app uses the exact same CSS.
import { ThemeProvider } from "@/lib/theme";
import { LocaleProvider } from "@/lib/i18n/client";
import { AuthLifecycleProvider } from "@/components/auth/auth-provider";
import { PwaManager } from "@/components/pwa-manager";
import { NativeApp } from "@/native/native-app";
import { AssistantPopup, isAssistantWindow } from "@/native/assistant-popup";
import { installNativeApiTransport } from "@/native/api-transport";
import { optionalAuthHeaders } from "@/lib/client/api";

// Before anything renders: send the shared components' `/api/*` calls to the
// QORVYNA backend (natively) instead of the bundled files. See api-transport.ts.
installNativeApiTransport({ authHeaders: () => optionalAuthHeaders() });

const container = document.getElementById("qorvyna-root");
// The floating assistant is the SAME bundle in a different window: Tauri opens
// `index.html?window=assistant` for the `assistant` window, so the popup mounts
// the compact assistant surface instead of the full shell. No second app.
const assistantWindow = isAssistantWindow(window.location.search);
if (container && assistantWindow) {
  createRoot(container).render(
    <ThemeProvider>
      <LocaleProvider>
        <AssistantPopup />
      </LocaleProvider>
    </ThemeProvider>,
  );
} else if (container) {
  // The native shell always opens on chat; history inside the app is real.
  // Tauri loads the window from `index.html` (tauri.conf.json → url), so the
  // bundle's own document path means "app start", not a route — otherwise the
  // router starts on `/index.html` and shows "This screen is not in the app".
  const launchPath = typeof window !== "undefined" ? window.location.pathname : "/";
  const startPath = launchPath.length > 1 && !/^\/index\.html?$/i.test(launchPath)
    ? `${launchPath}${window.location.search}`
    : "/chat";
  createRoot(container).render(
    <ThemeProvider>
      <LocaleProvider>
        <AuthLifecycleProvider>
          <PwaManager />
          <NativeApp startPath={startPath} />
        </AuthLifecycleProvider>
      </LocaleProvider>
    </ThemeProvider>,
  );
}
