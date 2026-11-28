package ai.matrix.desktop

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Native "Continue with Google" for the Android app.
 *
 * Google does not allow its OAuth pages inside an embedded WebView, so the web
 * popup/redirect flow opens a detached window that never lists the accounts on
 * the phone. Android's Credential Manager instead shows the system bottom
 * sheet with every Google account signed in on the device, and returns a
 * Google ID token for the app's Web OAuth client. The frontend hands that
 * token to Firebase (`signInWithCredential`) — the same Firebase user as on
 * the website.
 *
 * Google only issues the token when this app's package + signing-certificate
 * SHA-1 is registered for the Firebase project (signing/README.md).
 *
 * Rejection codes (read by src/lib/auth/oauth.ts):
 *   CANCELLED      — the user dismissed the sheet;
 *   NO_ACCOUNT     — no usable Google account / app not registered with Google;
 *   GOOGLE_FAILED  — any other Credential Manager / token error (message has detail).
 */
object QorvynaGoogleSignIn {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun signIn(activity: Activity, webClientId: String, invoke: Invoke) {
        if (webClientId.isBlank()) {
            invoke.reject("The app was built without a Google Web client ID.", "GOOGLE_FAILED")
            return
        }
        scope.launch {
            val manager = CredentialManager.create(activity)
            try {
                val response = try {
                    // Bottom sheet listing every Google account on the device.
                    val accounts = GetGoogleIdOption.Builder()
                        .setServerClientId(webClientId)
                        .setFilterByAuthorizedAccounts(false)
                        .setAutoSelectEnabled(false)
                        .build()
                    manager.getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(accounts).build())
                } catch (_: NoCredentialException) {
                    // No account offered by the sheet: the full "Sign in with
                    // Google" flow, which also lets the user add an account.
                    val button = GetSignInWithGoogleOption.Builder(webClientId).build()
                    manager.getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(button).build())
                }
                invoke.resolve(tokenObject(response))
            } catch (_: GetCredentialCancellationException) {
                invoke.reject("Google sign-in was cancelled.", "CANCELLED")
            } catch (error: NoCredentialException) {
                invoke.reject(
                    "No Google account is available for QORVYNA on this device. ${error.message ?: ""}".trim(),
                    "NO_ACCOUNT",
                )
            } catch (error: GetCredentialException) {
                invoke.reject("${error.type}: ${error.message ?: "Google sign-in failed."}", "GOOGLE_FAILED")
            } catch (error: GoogleIdTokenParsingException) {
                invoke.reject("Google returned an unreadable ID token: ${error.message}", "GOOGLE_FAILED")
            } catch (error: Throwable) {
                invoke.reject("${error.javaClass.simpleName}: ${error.message ?: "Google sign-in failed."}", "GOOGLE_FAILED")
            }
        }
    }

    private fun tokenObject(response: GetCredentialResponse): JSObject {
        val credential = response.credential
        if (credential !is CustomCredential ||
            credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
        ) {
            throw IllegalStateException("Unexpected credential type: ${credential.type}")
        }
        val google = GoogleIdTokenCredential.createFrom(credential.data)
        return JSObject().apply {
            put("idToken", google.idToken)
            put("email", google.id)
            put("displayName", google.displayName ?: "")
        }
    }
}
