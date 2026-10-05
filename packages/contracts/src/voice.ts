import * as Schema from "effect/Schema";

/**
 * Voice input: the browser records a short clip and POSTs the raw audio bytes
 * (body = the recording, `Content-Type` = its MIME type) to this route on the
 * primary environment; the server transcribes it and answers with
 * `VoiceTranscriptionResult`. Failures answer `VoiceTranscriptionFailure`.
 */
export const VOICE_TRANSCRIPTION_ROUTE_PATH = "/api/voice/transcribe";

/** Matches the transcription API's own upload limit. */
export const VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export const VoiceTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

export const VoiceTranscriptionFailureReason = Schema.Literals([
  "not_configured",
  "empty_audio",
  "audio_too_large",
  "upstream_error",
]);
export type VoiceTranscriptionFailureReason = typeof VoiceTranscriptionFailureReason.Type;

export const VoiceTranscriptionFailure = Schema.Struct({
  reason: VoiceTranscriptionFailureReason,
  message: Schema.String,
});
export type VoiceTranscriptionFailure = typeof VoiceTranscriptionFailure.Type;
