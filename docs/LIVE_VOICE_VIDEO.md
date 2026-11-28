# Web voice assistant and Gemini Live

## Existing wake / command flow

Enable foreground wake listening in Jarvis settings, allow browser microphone access,
and say **Hey AI**. Recognition releases the mic before the shared recorder starts.
The web page shows a listening dialog and the composer recording indicator/waveform.
Pause briefly to send (hands-free mode), choose **Send now**, or cancel. Saying
“Hey AI” with a command in the same utterance sends that command directly.

Wake recognition pauses during capture, transcription, AI generation, audio playback,
and while the Live dialog is open. It stops on hidden tabs and resumes on return.
Repeated disconnects and service/permission errors stop rather than retrying forever.
SpeechRecognition support and speech-service availability vary by browser; it is
not guaranteed to be local/on-device. The native assistant popup remains separate.

## Configure Live (server operator)

1. Use Node.js 22 or newer (required by the GenAI SDK). Configure Firebase
   Admin/session authentication and Firestore as usual.
2. In the deployment's **server-only** secret/environment settings, set
   `GEMINI_API_KEY` and `GEMINI_LIVE_MODEL`. Choose a currently available
   **Live audio-output** model from your Gemini account's catalog, with video
   input support if camera use is desired. Text-only Gemini model IDs will not work.
   No default model ID is assumed. Never prefix the API key with `NEXT_PUBLIC_`.
3. Redeploy. Serve the web application over HTTPS. If using a custom CSP/proxy,
   allow the Gemini Live WebSocket endpoint `wss://generativelanguage.googleapis.com`,
   same-origin AudioWorklet scripts, and microphone/camera for the app origin.
   The repository's web headers allow only same-origin camera/mic; users still
   grant permission in the browser.
4. Ensure the provider account has quota and that the model is available in the
   user's region. The app does not enable paid billing automatically.

`POST /api/voice/live-token` checks session authentication, same-origin CSRF,
validates the language and uses a Firestore transaction to limit token issuance
(20-second spacing, 12 starts/hour/account). Only a one-use ephemeral token is
returned: 60 seconds to start, 10 minutes maximum session lifetime, constrained
to the server-selected model and audio/system configuration. API keys and provider
error details are never returned. `voice_live_limits` contains only per-account
quota counters and remains inaccessible to clients under the default-deny rules.

## Use Live

- Choose a speech language in voice settings, or **Auto** to follow the speaker.
- Choose **Live voice & video**, optionally enable the camera, then **Start Live**.
- Live microphone audio is 16 kHz PCM. Audio replies are streamed PCM, not browser
  TTS, so they do not depend on installed system voices. Actual language coverage
  depends on the configured provider model. Auto mode can follow mixed languages.
- Camera shares JPEG frames at one frame/second with a local preview. It can be
  stopped without ending the audio session. Camera failure/permission denial is
  explicit; restart with camera unchecked for voice-only use.
- During AI playback the client sends silence instead of forwarding microphone input,
  without reconnecting the mic. **Interrupt reply** clears queued playback so you
  can speak. **Mute microphone** disables the audio track without releasing it;
  **End session** stops all tracks, worklets, playback, timers and the connection.
- Closing the dialog, hiding the tab, navigation/unmount, provider errors and the
  session limit clean up resources. Late permission grants/connection completions
  are discarded and closed instead of reviving an ended session.

This is a separate, web-only conversation: it does not read existing chat history,
persist transcripts/media, or execute agent/device tools. On installed Android /
Windows shells it explicitly directs users to the web; existing native voice
features remain available. Google receives streamed audio and optional images;
Google's applicable data/retention policies still apply. Use headphones for echo
control. Low latency depends on network and provider load; it is not guaranteed.

Normal read-aloud still supports the optional OpenAI-compatible speech endpoint
and browser voices. Browser fallback now follows the selected language, reports
missing installed language support, and settles on cancellation, error or a missing
end-event timeout. Whisper transcription uses transcription endpoints (not English
translation); it already preserves the original language and has regression tests
for multilingual input. Live offers an alternative end-to-end voice path.

## Acceptance / limits of local verification

Automated tests mock provider/media boundaries. They verify wake lifecycle under
streamed rerenders; capture ownership; pending permission cancellation; token
constraints, auth, CSRF and quotas; resampling/PCM; Live playback completion,
mute, provider disconnect and late-session cleanup. Production browser smoke
checks verify token HTTP auth/CSRF and the worklet/permission headers.

Before calling the integration production-verified, test with real credentials,
HTTPS and physical mic/speakers/camera: English, Bangla, mixed Bangla-English and
another supported language; camera visual questions; permission denial; repeated
turns; interrupt/mute/end; hide/show tab; navigation and network disconnection.
Watch the browser's media indicator: no repeated reconnects during a reply, and
no active tracks after ending. Inspect provider usage/quota separately.
