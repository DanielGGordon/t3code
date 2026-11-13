/**
 * One voice dictation, from the microphone to the finished text. Where Web Audio is available the
 * recording is cut at pauses and the pieces are transcribed while the user is still talking, so
 * `finish()` only waits for the last piece. Elsewhere it records one clip and uploads it at the end.
 */
import * as Schema from "effect/Schema";
import { describeEmptyRecording } from "./captureDiagnostics";
import { createChunkTranscriber, type ChunkTranscript } from "./chunkTranscriber";
import {
  ChunkedRecordingUnavailableError,
  isChunkedVoiceRecordingSupported,
  startChunkedVoiceRecording,
} from "./chunkedRecorder";
import { startVoiceRecording } from "./recorder";
import { transcribeVoiceRecording } from "./transcriptionClient";

const isChunkedRecordingUnavailable = Schema.is(ChunkedRecordingUnavailableError);

export interface VoiceDictationSession {
  /** Stops recording and resolves with the text of everything recorded; never rejects. */
  readonly finish: () => Promise<ChunkTranscript>;
  /** Stops recording and throws everything away. */
  readonly cancel: () => void;
}

async function startSingleClipSession(): Promise<VoiceDictationSession> {
  const recording = await startVoiceRecording();
  return {
    finish: async () => {
      try {
        return { text: await transcribeVoiceRecording(await recording.stop()), error: null };
      } catch (cause) {
        return {
          text: "",
          error: cause instanceof Error ? cause : new Error("Transcription failed."),
        };
      }
    },
    cancel: recording.cancel,
  };
}

export async function startVoiceDictationSession(): Promise<VoiceDictationSession> {
  if (!isChunkedVoiceRecordingSupported()) return startSingleClipSession();
  const transcriber = createChunkTranscriber({
    transcribe: (wav, context) => transcribeVoiceRecording(wav, { context }),
  });
  try {
    const recording = await startChunkedVoiceRecording((wav) => transcriber.add(wav));
    return {
      finish: async () => {
        recording.stop();
        const transcript = await transcriber.finish();
        const diagnostics = recording.diagnostics();
        // Web Audio can stall on a phone: the context pauses and the rest of the recording never
        // arrives. The plain clip recorded alongside has all of it.
        if (diagnostics.contextPauses > 0 || (transcript.text.length === 0 && !transcript.error)) {
          const clip = await recording.fullClip();
          if (clip && clip.size > 0) {
            try {
              const text = (await transcribeVoiceRecording(clip)).trim();
              if (text.length > 0) return { text, error: null };
            } catch {
              // keep what the pieces gave
            }
          }
        }
        if (transcript.text.length > 0 || transcript.error) return transcript;
        // Nothing was sent or nothing came back: say what the microphone did instead of a bare "no speech".
        return {
          text: "",
          error: new Error(describeEmptyRecording(diagnostics)),
        };
      },
      cancel: () => {
        transcriber.cancel();
        recording.cancel();
      },
    };
  } catch (cause) {
    if (isChunkedRecordingUnavailable(cause)) return startSingleClipSession();
    throw cause;
  }
}
