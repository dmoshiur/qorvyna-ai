# QORVYNA Android release signing

This folder holds the **release signing key** used by
`.github/workflows/android-apk.yml` so every published APK is signed with the
same identity and installs can update in place.

| File | Purpose |
|---|---|
| `qorvyna-upload.jks` | The keystore (alias `qorvyna`). |
| `keystore-password.txt` | Keystore + key password (same value). |
| `keystore.properties` | **Generated in CI only** — never commit it. |

## Every build uses this key

`scripts/native/patch-android-manifest.mjs` attaches this key to **both** the
debug and release buildTypes of the generated Gradle project. It uses
`keystore.properties` when present, otherwise this committed keystore. Local
`--debug` builds, local release builds and CI builds therefore all share one
certificate and can update each other in place. Android rejects an APK signed
with a different certificate: *"App not installed as package conflicts with an
existing package"*. If a phone still has an older copy signed with a machine
debug key, uninstall it once. Later installs then update in place.

## Keystore fingerprints (add these in the Firebase console)

```
SHA-1:   C8:BB:B1:8B:94:57:30:A5:05:96:63:84:06:9F:35:EE:9E:F2:98:09
SHA-256: A5:2A:F2:9E:AD:2F:9E:67:BC:12:E5:62:D2:89:89:29:B6:7D:77:86:DA:24:2A:B2:94:1A:B9:7A:69:47:DE:CF
```

Firebase console → Project settings → Your apps → **ai.matrix.desktop**
→ Add fingerprint — paste both. This lets Firebase's native app checks
 recognise updates signed with this key.

**Required for "Continue with Google" in the app.** The Android app signs in
with the phone's own Google account sheet (Credential Manager). Google only
issues the sign-in token to an app whose package name + signing SHA-1 are
registered in the Firebase project, so until these fingerprints are added the
app shows "Google did not accept the app's signing certificate" (developer
error 10 / 28444) and email/password sign-in remains available. No new build
is needed after adding them; Google picks up the change within minutes.

## Security note

This is a **debug-grade** distribution key committed so the public CI build can
sign releases without secrets infrastructure. It is NOT a Play-Store key. To
rotate to a private key later:

1. Create a new keystore (`keytool -genkeypair …`).
2. Set the four repository secrets — `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
   (the workflow prefers them over the committed files).
3. Add the new SHA-1/SHA-256 fingerprints in Firebase, and delete these files.
