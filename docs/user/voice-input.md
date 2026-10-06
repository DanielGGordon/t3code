# Voice input

The composer has a microphone button next to send. Tap it to record, then:

- **✓ (insert)** — stop and put the transcript in the composer so you can edit it before sending.
- **↑ (send)** — stop and send the transcript straight away.
- **✕** — stop and throw the recording away.

The browser records the clip and uploads it to the server
(`POST /api/voice/transcribe`), which transcribes it with OpenAI and returns the
text. Recordings stop on their own after 10 minutes. Inserting a transcript does
not focus the text box, so on a touch screen the on-screen keyboard stays down.

## Keyboard on demand (touch screens)

On a touch screen you mostly dictate on — a car display, say — turn on
**Settings → Features → Composer → Keyboard on demand**. Tapping the message box
then no longer raises the on-screen keyboard; a keyboard button next to the mic
does, and tapping it again (or anywhere outside the box) puts the keyboard away.
The setting is stored per device.

## Server setup

The server needs an OpenAI API key. It checks, in order:

1. `<base-dir>/userdata/secrets/voice-transcription-openai-api-key.bin` — the
   key as plain text (mode `600`). Read on every request, so no restart is needed.
2. The `OPENAI_API_KEY` environment variable.

`T3CODE_VOICE_TRANSCRIPTION_MODEL` overrides the model (default `gpt-transcribe`).

## Browser requirements

Microphone access needs a secure context: `https://` with a certificate the
browser trusts, or `http://localhost`. The mic button is hidden in browsers
without `MediaRecorder` or `getUserMedia`. If the browser blocks the
microphone, allow it in that site's settings.
