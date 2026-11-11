import * as Schema from "effect/Schema";

/**
 * Voice input: the browser POSTs the raw recording (`Content-Type` = its MIME type) here and gets
 * `VoiceTranscriptionResult`, or `VoiceTranscriptionFailure`.
 * Not `/api/voice/transcribe`: upstream serves that path with a raw-PCM body.
 */
export const VOICE_TRANSCRIPTION_ROUTE_PATH = "/api/fork/voice/transcribe";

/**
 * Optional query parameter on the route: the end of the text already transcribed from the same
 * recording. The server appends it to Whisper's `prompt` so a long recording sent in pieces keeps
 * its capitalisation and sentences across the cuts. Longer values are cut to their last
 * `VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS` characters.
 */
export const VOICE_TRANSCRIPTION_CONTEXT_PARAM = "context";
export const VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS = 400;

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
