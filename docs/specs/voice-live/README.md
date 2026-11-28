# Voice lifecycle and Live sessions

## Specification / plan
- Preserve Firebase session authentication, CSRF checks and server-only provider secrets.
- Web wake listening is foreground-only browser recognition (the browser may use its speech service, not guaranteed on-device). No native popup is required: wake activation hands off to the shared recorder and an accessible in-page dialog.
- Exactly one capture owner: suspend wake recognition during recording, generation, playback and Live sessions. Callback/render changes must not restart recognition. Cancel timers/listeners on teardown and stop on hidden tabs.
- Live is a separate, explicitly consented Gemini audio/video session, not the agent/tool executor. Audio replies stream as PCM; optional camera frames are JPEG at 1 fps. No chat history or media is stored by this feature. Provider data policies still apply.
- Use authenticated, rate-limited, one-use ephemeral tokens locked to server-selected model/config; never return an API key. Require explicit model configuration rather than claiming an unverified model works.
- Follow the selected language, or the speaker's language in auto mode; never instruct translation into English. Browser TTS depends on installed language voices and must not silently substitute an English voice.

## Tasks / acceptance
1. Stabilize wake lifecycle, handoff, foreground resume, bounded retry and web recording UI.
2. Make playback cancellation/error/end settle UI; ignore late generated-audio requests.
3. Add token route, streaming audio/camera client, mute, interrupt, end, timeout and cleanup.
4. Test lifecycle, PCM conversion, token auth/constraints/failures; run typecheck, tests, build and native frontend check.

## Verification boundary
Mocked/unit checks do not verify provider availability or device audio quality. Real Gemini access, supported regional/model availability, HTTPS, browser microphone/camera grants and speakers are required for end-to-end acceptance. Live is explicitly web-only in this release; native shells retain their existing assistant and show a browser-use notice. Live does not execute device actions or share existing conversation context.

## Implementation status
Implemented the four tasks above, including regression coverage and a server-configuration / device-acceptance guide in `docs/LIVE_VOICE_VIDEO.md`. Existing text-chat and agent routing are unchanged. Local checks: TypeScript, full Vitest suite (174 files / 1812 tests), production Next build, native frontend rebuild/check, and production Chromium HTTP/auth/CSRF/static-worklet smoke checks. No real Gemini inference or physical microphone/camera acceptance was performed: this checkout has no Firebase/Gemini deployment credentials.
