#!/usr/bin/env node
// =============================================================================
// QORVYNA — boot smoke test for the bundled app frontend (public/native).
//
// Loads the bundle the way the Android/desktop app does — served from
// http://tauri.localhost/index.html with the CSP from tauri.conf.json and an
// Android WebView user agent — in real headless Chromium, and fails when:
//   • the bundle throws while booting (e.g. "process is not defined"),
//   • nothing renders into #qorvyna-root (the blank white screen), or
//   • the design-system stylesheet is missing (app renders unstyled).
//
// Usage: node scripts/native/smoke-native-bundle.mjs
//   CHROME_PATH=/path/to/chrome overrides the browser (CI: system Chrome);
//   otherwise @sparticuz/chromium (a devDependency) is used.
// =============================================================================
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium as playwright } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "public", "native");
const fail = (message) => {
  console.error(`\n[native-smoke] FAILED: ${message}\n`);
  process.exit(1);
};

if (!existsSync(join(dist, "index.html"))) fail("public/native/index.html is missing — build the bundle first.");

const css = readFileSync(join(dist, "app.css"), "utf8");
for (const marker of [".flex{", ".min-h-dvh{"]) {
  if (!css.includes(marker)) fail(`app.css has no "${marker}" rule — the Tailwind design system is missing (app would render unstyled).`);
}

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const csp = Object.entries(conf.app.security.csp).map(([key, value]) => `${key} ${value}`).join("; ");
const types = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg",
};

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://tauri.localhost").pathname);
  const file = normalize(join(dist, pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  const headers = { "content-type": types[extname(file)] ?? "application/octet-stream" };
  if (file.endsWith(".html")) headers["content-security-policy"] = csp;
  res.writeHead(200, headers).end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;

let executablePath = process.env.CHROME_PATH;
let args = [];
if (!executablePath) {
  const { default: chromium, inflate } = await import("@sparticuz/chromium");
  if (process.platform === "linux" && !process.env.AWS_EXECUTION_ENV) {
    const packageDir = dirname(createRequire(import.meta.url).resolve("@sparticuz/chromium"));
    const libraries = await inflate(join(packageDir, "../bin/al2023.tar.br"));
    process.env.LD_LIBRARY_PATH = [join(libraries, "lib"), join(tmpdir(), "swiftshader"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  executablePath = await chromium.executablePath();
  args = chromium.args;
}

const browser = await playwright.launch({
  executablePath,
  headless: true,
  args: [...args, `--host-resolver-rules=MAP tauri.localhost 127.0.0.1:${port}`],
});
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://tauri.localhost/index.html", { waitUntil: "load", timeout: 30_000 });
  // Wait for the shell to mount anything (splash, login or workspace).
  await page
    .waitForFunction(() => (document.getElementById("qorvyna-root")?.innerText ?? "").trim().length > 0, null, { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(1_500);
  const text = (await page.evaluate(() => document.getElementById("qorvyna-root")?.innerText ?? "")).trim();
  // The design system paints the page background on <html> (tokens: --bg).
  const styled = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor !== "rgba(0, 0, 0, 0)");
  if (errors.length) fail(`the bundle threw while booting:\n  - ${errors.join("\n  - ")}`);
  if (!text) fail("nothing rendered into #qorvyna-root — the app would open to a blank white screen.");
  if (!styled) fail("the page has no design-system background — the stylesheet did not apply.");
  console.log(`[native-smoke] OK — the app booted and rendered: ${JSON.stringify(text.slice(0, 120))}…`);
} finally {
  await browser.close();
  server.close();
}
