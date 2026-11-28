// =============================================================================
// The APK opened to a blank white screen. Two build bugs caused it:
//   1. `next/navigation` / `next/link` / `next/image` were bundled as Next's
//      real runtime, which reads process.env.__NEXT_* → "process is not
//      defined" at boot. The native shell ships drop-in replacements; the
//      bundler must alias to them.
//   2. esbuild wrote component CSS (KaTeX) to app.css, overwriting the
//      Tailwind design system → unstyled app.
// Plus: the window loads `index.html`, which must start the router on /chat.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const BUILD = readFileSync(path.join(ROOT, "scripts/native/build-native-frontend.mjs"), "utf8");
const ENTRY = readFileSync(path.join(ROOT, "src/native/client/entry.tsx"), "utf8");
const ROUTER = readFileSync(path.join(ROOT, "src/native/router.tsx"), "utf8");
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/android-apk.yml"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("native bundle boots in the WebView", () => {
  it("aliases next/navigation, next/link and next/image to the native shell", () => {
    expect(BUILD).toContain("--alias:next/navigation=./src/native/router.tsx");
    expect(BUILD).toContain("--alias:next/link=./src/native/router.tsx");
    expect(BUILD).toContain("--alias:next/image=./src/native/next-image.tsx");
  });

  it("the native router provides every next/navigation name the shared components import", () => {
    for (const name of ["useRouter", "usePathname", "useSearchParams", "redirect", "notFound"]) {
      expect(ROUTER).toMatch(new RegExp(`export function ${name}\\b`));
    }
    expect(ROUTER).toContain("export default Link");
  });

  it("does not let esbuild overwrite the Tailwind stylesheet", () => {
    expect(BUILD).toMatch(/"--output",\s*cssOut/);
    expect(BUILD).toContain('const tailwindOut = join(outDir, ".tailwind.css")');
    expect(BUILD).toContain("const cssOut = tailwindOut;");
    expect(BUILD).toContain("Merge: the design system first");
  });

  it("treats the bundle's own index.html as app start (opens /chat)", () => {
    expect(ENTRY).toContain("/^\\/index\\.html?$/i");
    const isStart = (p: string) => !(p.length > 1 && !/^\/index\.html?$/i.test(p));
    expect(isStart("/index.html")).toBe(true);
    expect(isStart("/")).toBe(true);
    expect(isStart("/chat/abc")).toBe(false);
  });

  it("CI boot-tests the bundle before publishing an APK", () => {
    expect(pkg.scripts["native:smoke"]).toBe("node scripts/native/smoke-native-bundle.mjs");
    const smoke = WORKFLOW.indexOf("npm run native:smoke");
    expect(smoke).toBeGreaterThan(WORKFLOW.indexOf("npm run android:apk:release"));
    expect(smoke).toBeLessThan(WORKFLOW.indexOf("Publish the public APK release"));
  });
});
