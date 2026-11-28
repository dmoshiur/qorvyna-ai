// =============================================================================
// Android install/update: every APK must carry the SAME signing certificate.
//
// Android only replaces an installed app with an APK signed by the same
// certificate; otherwise it fails with "App not installed as package conflicts
// with an existing package". The Tauri Gradle template has no signing config,
// so debug builds used each machine's random debug.keystore. These tests run
// the real patch script against a Tauri-shaped build.gradle.kts and pin that
// debug AND release are wired to one key, idempotently.
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/native/patch-android-manifest.mjs");

// Shape of tauri-cli templates/mobile/android/app/build.gradle.kts (rendered).
const TEMPLATE = `import java.util.Properties

android {
    compileSdk = 36
    namespace = "ai.matrix.desktop"
    defaultConfig {
        applicationId = "ai.matrix.desktop"
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`;

const LEGACY_PATCHED = TEMPLATE.replace(
  "android {\n",
  `android {
    // QORVYNA release signing (patch-android-manifest.mjs)
    signingConfigs {
        val keystorePropertiesFile = rootProject.file("keystore.properties")
        if (keystorePropertiesFile.exists()) {
            create("release") {
                val keystoreProperties = Properties()
                keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }
`,
).replace(
  '        getByName("release") {\n',
  `        getByName("release") {
            // QORVYNA release signing (patch-android-manifest.mjs) (release buildType)
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
`,
);

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function project(gradle: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qorvyna-sign-"));
  dirs.push(dir);
  const app = path.join(dir, "src-tauri/gen/android/app");
  mkdirSync(path.join(app, "src/main"), { recursive: true });
  writeFileSync(path.join(app, "build.gradle.kts"), gradle);
  writeFileSync(
    path.join(app, "src/main/AndroidManifest.xml"),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application>\n    </application>\n</manifest>\n',
  );
  const run = () => execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  const read = () => readFileSync(path.join(app, "build.gradle.kts"), "utf8");
  return { run, read };
}

function blockOf(gradle: string, type: "debug" | "release") {
  const start = gradle.indexOf(`getByName("${type}") {`);
  return gradle.slice(start, gradle.indexOf("\n        }", start));
}

describe("Android APK signing — one certificate for every build", () => {
  it("signs debug AND release builds with the same signing config", () => {
    const p = project(TEMPLATE);
    p.run();
    const gradle = p.read();
    expect(gradle.match(/create\("release"\)/g)?.length).toBe(2); // keystore.properties | committed key
    for (const type of ["debug", "release"] as const) {
      expect(blockOf(gradle, type)).toContain('signingConfigs.findByName("release")?.let { signingConfig = it }');
    }
  });

  it("falls back to the committed QORVYNA keystore when keystore.properties is absent", () => {
    const p = project(TEMPLATE);
    p.run();
    const gradle = p.read();
    expect(gradle).toContain('rootProject.file("../../../signing/qorvyna-upload.jks")');
    expect(gradle).toContain('rootProject.file("../../../signing/keystore-password.txt")');
    expect(gradle).toContain('keyAlias = "qorvyna"');
    // rootProject is src-tauri/gen/android → ../../.. is the repo root.
    expect(readFileSync(path.join(ROOT, "signing/qorvyna-upload.jks")).length).toBeGreaterThan(0);
    expect(readFileSync(path.join(ROOT, "signing/keystore-password.txt"), "utf8").trim()).not.toBe("");
  });

  it("is idempotent", () => {
    const p = project(TEMPLATE);
    p.run();
    const once = p.read();
    p.run();
    expect(p.read()).toBe(once);
  });

  it("upgrades a project patched by the old release-only block", () => {
    const fresh = project(TEMPLATE);
    fresh.run();
    const legacy = project(LEGACY_PATCHED);
    expect(legacy.run()).toContain("Upgrading the previous release-only signing patch");
    expect(legacy.read()).not.toContain("QORVYNA release signing");
    expect(legacy.read()).toBe(fresh.read());
  });

  it("CI refuses to publish an APK signed with any other certificate", () => {
    const workflow = readFileSync(path.join(ROOT, ".github/workflows/android-apk.yml"), "utf8");
    expect(workflow).toContain("Signer #1 certificate SHA-256 digest");
    expect(workflow).toContain("refusing to publish");
  });
});
