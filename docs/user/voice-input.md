# Voice input

The composer has a microphone button next to send. Tap it to record, then:

- **✓ (insert)** — stop and put the transcript in the composer so you can edit it before sending.
- **↑ (send)** — stop and send the transcript straight away.
- **✕** — stop and throw the recording away.

While you talk, the browser cuts the recording at pauses into pieces of 4–15 seconds
and uploads each one as soon as it is cut (`POST /api/voice/transcribe`). The server
transcribes them — with a local Whisper server, OpenAI, or both — one after another,
so when you tap ✓ or ↑ only the last piece is left to wait for (a couple of seconds,
however long you talked). The text so far goes along with each piece as Whisper's prompt
(`?context=`, last 400 characters), so sentences and capitalisation carry across the
cuts. If a piece fails for good, the text that was transcribed is inserted for you to
review instead of being sent. Browsers without Web Audio fall back to uploading one clip
at the end. Recordings stop on their own after 10 minutes. Inserting a transcript does
not focus the text box, so on a touch screen the on-screen keyboard stays down.

## Keyboard on demand (touch screens)

On a touch screen you mostly dictate on — a car display, say — turn on
**Settings → Features → Composer → Keyboard on demand**. Tapping the message box
then no longer raises the on-screen keyboard; a keyboard button next to the mic
does, and tapping it again (or anywhere outside the box) puts the keyboard away.
The setting is stored per device.

## Server setup

The server transcribes with a self-hosted Whisper server, OpenAI, or both.

**Local Whisper (free, audio stays on your machine).** Run any server with an
OpenAI-compatible `/v1/audio/transcriptions` endpoint, such as
[Speaches](https://speaches.ai), and point the server at it:

```sh
docker run -d --restart unless-stopped -p 127.0.0.1:8650:8000 \
  -e WHISPER__TTL=-1 -e WHISPER__CPU_THREADS=16 -e WHISPER__COMPUTE_TYPE=int8 \
  ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://127.0.0.1:8650/v1/models/Systran/faster-whisper-medium.en
export T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL=http://127.0.0.1:8650
```

`T3CODE_VOICE_TRANSCRIPTION_LOCAL_MODEL` picks the model (default
`Systran/faster-whisper-medium.en`, which handles a 10-second clip in about
three seconds and a minute in about twelve on a modern CPU). Avoid the
`distil` models for dictation: they are faster but silently drop the end of
recordings longer than about 30 seconds.

**Vocabulary hint.** Whisper mishears names it has never seen ("tee three code"
for T3 Code). Set `T3CODE_VOICE_TRANSCRIPTION_PROMPT` to a short, comma-separated
list of the names and jargon you say often and the server passes it to the local
and OpenAI backends as Whisper's `prompt`. Whisper only reads roughly the last
220 tokens of it, so keep it to the terms that actually get mangled.

**OpenAI.** Without a local server, or when it fails, the server uses OpenAI.
It looks for the API key in, in order:

1. `<base-dir>/userdata/secrets/voice-transcription-openai-api-key.bin` — the
   key as plain text (mode `600`). Read on every request, so no restart is needed.
2. The `OPENAI_API_KEY` environment variable.

`T3CODE_VOICE_TRANSCRIPTION_MODEL` overrides the OpenAI model (default
`gpt-transcribe`). If OpenAI answers that the account's quota or spend limit is
used up, voice input says so; add credits or raise the limit in the OpenAI
dashboard.

## Browser requirements

Microphone access needs a secure context: `https://` with a certificate the
browser trusts, or `http://localhost`. The mic button is hidden in browsers
without `MediaRecorder` or `getUserMedia`. If the browser blocks the
microphone, allow it in that site's settings.
