#!/usr/bin/env node
/**
 * Finish the Android project that `tauri android init` generates.
 *
 * `src-tauri/gen/android` is generated, so it is never hand-edited: this script
 * is idempotent and runs after init (`npm run android:init` chains it), or on
 * its own via `npm run android:manifest`.
 *
 * It does three things, each verified before writing:
 *
 *   1. copies every Kotlin source from `src-tauri/android/.../kotlin/` into the
 *      generated app module, so the notification listener AND the assistant
 *      plugin/service/activity are actually compiled into the APK;
 *   2. declares what those classes need in `AndroidManifest.xml`:
 *        • the notification-listener binding permission and service;
 *        • the floating-assistant foreground service (microphone type);
 *        • the `ASSIST` activity that gives QORVYNA the digital-assistant role;
 *        • `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `FOREGROUND_SERVICE*`,
 *          `POST_NOTIFICATIONS` — declared, not granted: the user still has to
 *          allow each one, and the app reports the real state either way;
 *   3. prints exactly what changed so a build log never lies about it.
 *
 * It refuses to invent a project: without `tauri android init` it exits with a
 * clear message instead of creating a half-working tree.
 */
import { cp, mkdir, readdir, readFile, stat, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const GEN = path.join(ROOT, "src-tauri/gen/android");
const MANIFEST = path.join(GEN, "app/src/main/AndroidManifest.xml");
const KOTLIN_SOURCE = path.join(ROOT, "src-tauri/android/app/src/main/kotlin");
const JAVA_TARGET = path.join(GEN, "app/src/main/java");

const NOTIFICATION_SERVICE = "ai.matrix.desktop.QorvynaNotificationListenerService";
const NOTIFICATION_PERMISSION = "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE";
const ASSISTANT_SERVICE = "ai.matrix.desktop.QorvynaAssistantService";
const ASSIST_ACTIVITY = "ai.matrix.desktop.AssistActivity";

const NOTIFICATION_DECLARATION = `        <!-- QORVYNA notification forwarding. Requires explicit user enablement
             in system settings; declaring it grants no access on its own. -->
        <service
            android:name="${NOTIFICATION_SERVICE}"
            android:label="QORVYNA notification forwarding"
            android:exported="false"
            android:permission="${NOTIFICATION_PERMISSION}">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>`;

const ASSISTANT_DECLARATION = `        <!-- QORVYNA floating assistant: the bubble + on-device wake phrase.
             foregroundServiceType="microphone" is required from Android 14 for a
             service that records; nothing is recorded until the user enrols the
             wake phrase, and the audio never leaves the device. -->
        <service
            android:name="${ASSISTANT_SERVICE}"
            android:exported="false"
            android:foregroundServiceType="microphone" />
        <!-- Makes QORVYNA selectable under Settings → Apps → Default apps →
             Digital assistant. Exporting it is what the system needs to launch
             it; it forwards straight to the app and finishes. -->
        <activity
            android:name="${ASSIST_ACTIVITY}"
            android:exported="true"
            android:excludeFromRecents="true"
            android:launchMode="singleTask"
            android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`;

const PERMISSIONS = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.RECORD_AUDIO",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.POST_NOTIFICATIONS",
];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Copy the checked-in Kotlin sources into the generated app module. */
async function syncKotlin() {
  if (!(await exists(KOTLIN_SOURCE))) {
    console.log("[android] No Kotlin sources found — nothing to copy.");
    return [];
  }
  const copied = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!entry.name.endsWith(".kt")) continue;
      const relative = path.relative(KOTLIN_SOURCE, source);
      const target = path.join(JAVA_TARGET, relative);
      await mkdir(path.dirname(target), { recursive: true });
      const same =
        (await exists(target)) &&
        (await readFile(target, "utf8")) === (await readFile(source, "utf8"));
      if (same) continue;
      await cp(source, target);
      copied.push(relative);
    }
  };
  await walk(KOTLIN_SOURCE);
  if (copied.length === 0) console.log("[android] Kotlin sources already up to date.");
  else for (const file of copied) console.log(`[android] Copied ${file}`);
  return copied;
}

/** Add <uses-permission> entries that are missing, in declaration order. */
function declarePermissions(manifest) {
  const missing = PERMISSIONS.filter(
    (permission) => !manifest.includes(`android:name="${permission}"`),
  );
  if (missing.length === 0) return { manifest, added: [] };
  const application = /^[ \t]*<application/m.exec(manifest);
  if (!application) throw new Error("[android] Manifest has no <application> element; refusing to guess.");
  const block = missing.map((permission) => `    <uses-permission android:name="${permission}" />\n`).join("");
  return {
    manifest: `${manifest.slice(0, application.index)}${block}${manifest.slice(application.index)}`,
    added: missing,
  };
}

/** Insert one <application> child if its android:name is absent. */
function insertComponent(manifest, name, block) {
  if (manifest.includes(`android:name="${name}"`)) return { manifest, changed: false };
  if (!manifest.includes("</application>")) {
    throw new Error("[android] Manifest has no </application> element; refusing to guess.");
  }
  return {
    manifest: manifest.replace("</application>", `${block}\n    </application>`),
    changed: true,
  };
}

// -----------------------------------------------------------------------------
// App signing — ONE identity for every APK this project produces.
//
// Android only lets an APK replace an installed app when both are signed with
// the same certificate; otherwise the installer fails with "App not installed
// as package conflicts with an existing package". The Tauri-generated
// app/build.gradle.kts has no signing configuration at all, which caused that:
//   • release builds came out UNSIGNED (no device installs them), and
//   • debug builds were signed with the machine's auto-generated
//     ~/.android/debug.keystore — a different, random key on every CI runner
//     and every developer PC — so no two builds could update each other, and
//     none could update (or be updated by) the signed release APK.
//
// This wires a single `release` signing config, resolved in this order:
//   1. keystore.properties in the generated project root (CI writes it from
//      repository secrets / the committed key; a local build may provide one);
//   2. otherwise the committed QORVYNA key, signing/qorvyna-upload.jks
//      (alias `qorvyna`, password in signing/keystore-password.txt);
// and attaches it to BOTH the release and the debug buildTypes, so every APK —
// CI or local, `--debug` or release — installs over and updates the others.
// Idempotent: guarded by a marker comment; projects patched by the previous
// (release-only) version of this script are upgraded in place.
// -----------------------------------------------------------------------------
const SIGNING_MARKER = "// QORVYNA app signing v2 (patch-android-manifest.mjs)";

// Previous release-only blocks, removed verbatim when upgrading a project.
const LEGACY_SIGNING_MARKER = "// QORVYNA release signing (patch-android-manifest.mjs)";
const LEGACY_SIGNING_CONFIG_BLOCK = `    ${LEGACY_SIGNING_MARKER}
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
`;
const LEGACY_RELEASE_SIGNING_BLOCK = `            ${LEGACY_SIGNING_MARKER} (release buildType)
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
`;

// rootProject = src-tauri/gen/android, so ../../.. is the repository root.
const SIGNING_CONFIG_BLOCK = `    ${SIGNING_MARKER}
    signingConfigs {
        val keystorePropertiesFile = rootProject.file("keystore.properties")
        val committedKeystore = rootProject.file("../../../signing/qorvyna-upload.jks")
        val committedPassword = rootProject.file("../../../signing/keystore-password.txt")
        if (keystorePropertiesFile.exists()) {
            create("release") {
                val keystoreProperties = Properties()
                keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        } else if (committedKeystore.exists() && committedPassword.exists()) {
            create("release") {
                val password = committedPassword.readText().trim()
                keyAlias = "qorvyna"
                keyPassword = password
                storeFile = committedKeystore
                storePassword = password
            }
        }
    }
`;

const buildTypeSigningBlock = (type) => `            ${SIGNING_MARKER} (${type} buildType)
            signingConfigs.findByName("release")?.let { signingConfig = it }
`;

/** Insert `block` right after the line matching `regex` (must match once). */
function insertAfter(source, regex, block, what) {
  const match = regex.exec(source);
  if (!match) throw new Error(`[android] app/build.gradle.kts has no ${what} block; refusing to guess.`);
  const at = match.index + match[0].length;
  return `${source.slice(0, at)}${block}${source.slice(at)}`;
}

/** Wire one signing identity into the generated Gradle build (idempotent). */
async function patchGradleSigning() {
  const gradleFile = path.join(GEN, "app/build.gradle.kts");
  if (!(await exists(gradleFile))) {
    console.log("[android] app/build.gradle.kts not found — skipping signing patch.");
    return false;
  }
  let gradle = await readFile(gradleFile, "utf8");
  if (gradle.includes(SIGNING_MARKER)) {
    console.log("[android] Gradle app signing already wired.");
    return false;
  }
  if (gradle.includes(LEGACY_SIGNING_MARKER)) {
    gradle = gradle.replace(LEGACY_SIGNING_CONFIG_BLOCK, "").replace(LEGACY_RELEASE_SIGNING_BLOCK, "");
    if (gradle.includes(LEGACY_SIGNING_MARKER)) {
      throw new Error(
        "[android] app/build.gradle.kts has a hand-edited legacy signing block; refusing to guess. " +
          "Delete src-tauri/gen/android and re-run the build to regenerate it.",
      );
    }
    console.log("[android] Upgrading the previous release-only signing patch.");
  }

  gradle = insertAfter(gradle, /^android \{[^\S\n]*\n/m, SIGNING_CONFIG_BLOCK, "`android {`");
  gradle = insertAfter(gradle, /^[ \t]*getByName\("debug"\) \{[^\S\n]*\n/m, buildTypeSigningBlock("debug"), '`getByName("debug")`');
  gradle = insertAfter(gradle, /^[ \t]*getByName\("release"\) \{[^\S\n]*\n/m, buildTypeSigningBlock("release"), '`getByName("release")`');

  await writeFile(gradleFile, gradle, "utf8");
  return true;
}

// -----------------------------------------------------------------------------
// Native Google sign-in (QorvynaGoogleSignIn.kt) needs Android Credential
// Manager + the Google ID library + coroutines in the app module, and R8 must
// keep the Play Services credential provider, which Credential Manager loads by
// reflection (stripped in release builds otherwise). Idempotent: marker-guarded
// dependency block; the rules file is rewritten only when it differs.
// -----------------------------------------------------------------------------
const DEPENDENCY_MARKER = "// QORVYNA native Google sign-in (patch-android-manifest.mjs)";
const DEPENDENCY_BLOCK = `    ${DEPENDENCY_MARKER}
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
`;
const CREDENTIAL_RULES_FILE = "qorvyna-credentials.pro";
const CREDENTIAL_RULES = `# QORVYNA native Google sign-in (written by scripts/native/patch-android-manifest.mjs).
# Credential Manager instantiates the Play Services provider by reflection.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}
`;

/** Add the Credential Manager dependencies + R8 rules (idempotent). */
async function patchGoogleSignInDependencies() {
  const gradleFile = path.join(GEN, "app/build.gradle.kts");
  if (!(await exists(gradleFile))) {
    console.log("[android] app/build.gradle.kts not found — skipping Google sign-in dependencies.");
    return false;
  }
  let changed = false;
  const gradle = await readFile(gradleFile, "utf8");
  if (!gradle.includes(DEPENDENCY_MARKER)) {
    const block = /^dependencies \{[^\S\n]*\n/m.exec(gradle);
    const patched = block
      ? `${gradle.slice(0, block.index + block[0].length)}${DEPENDENCY_BLOCK}${gradle.slice(block.index + block[0].length)}`
      : // Gradle merges multiple `dependencies {}` blocks.
        `${gradle.replace(/\s*$/, "\n")}\ndependencies {\n${DEPENDENCY_BLOCK}}\n`;
    await writeFile(gradleFile, patched, "utf8");
    changed = true;
  }
  // The template's release buildType applies every **/*.pro under app/.
  const rulesFile = path.join(GEN, "app", CREDENTIAL_RULES_FILE);
  const current = (await exists(rulesFile)) ? await readFile(rulesFile, "utf8") : null;
  if (current !== CREDENTIAL_RULES) {
    await writeFile(rulesFile, CREDENTIAL_RULES, "utf8");
    changed = true;
  }
  return changed;
}

async function main() {
  if (!(await exists(MANIFEST))) {
    console.error(
      `[android] No Android project found at ${MANIFEST}.\n` +
        "[android] Run `npm run android:init` (tauri android init) first — this script never invents a project.",
    );
    process.exit(1);
  }

  const copied = await syncKotlin();
  const gradleSigned = await patchGradleSigning();
  const googleSignIn = await patchGoogleSignInDependencies();

  const original = await readFile(MANIFEST, "utf8");
  const permissions = declarePermissions(original);
  let manifest = permissions.manifest;

  const notification = insertComponent(manifest, NOTIFICATION_SERVICE, NOTIFICATION_DECLARATION);
  manifest = notification.manifest;
  const assistant = insertComponent(manifest, ASSISTANT_SERVICE, ASSISTANT_DECLARATION);
  manifest = assistant.manifest;

  const changed =
    copied.length > 0 ||
    gradleSigned ||
    googleSignIn ||
    permissions.added.length > 0 ||
    notification.changed ||
    assistant.changed;

  if (!changed) {
    console.log(
      "[android] Notification listener, assistant service/activity, Kotlin sources and app signing are " +
        "already in place — nothing to do.",
    );
  } else {
    await writeFile(MANIFEST, manifest, "utf8");
    for (const permission of permissions.added) console.log(`[android] Declared ${permission}`);
    if (notification.changed) console.log("[android] Declared QorvynaNotificationListenerService.");
    if (assistant.changed) {
      console.log("[android] Declared QorvynaAssistantService and AssistActivity (ASSIST role).");
    }
    if (gradleSigned) console.log("[android] Wired one app-signing key into the debug + release builds.");
    if (googleSignIn) console.log("[android] Added Credential Manager (native Google sign-in) dependencies + R8 rules.");
  }

  console.log(
    "[android] Still manual, by design: allow notification access, allow “Display over other apps”, " +
      "record the wake phrase, and pick QORVYNA as the digital assistant.",
  );
}

main().catch(async (error) => {
  console.error("[android] Failed:", error?.message ?? error);
  // Keep a clear failure for the build log instead of a half-patched project.
  try {
    await stat(MANIFEST);
  } catch {
    console.error("[android] The manifest was not written.");
  }
  process.exit(1);
});
