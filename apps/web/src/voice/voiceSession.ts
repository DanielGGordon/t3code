/**
 * One voice dictation, from the microphone to the finished text. Where Web Audio is available the
 * recording is cut at pauses and the pieces are transcribed while the user is still talking, so
 * `finish()` only waits for the last piece. Elsewhere it records one clip and uploads it at the end.
 */
import { createChunkTranscriber, type ChunkTranscript } from "./chunkTranscriber";
import {
  ChunkedRecordingUnavailableError,
  isChunkedVoiceRecordingSupported,
  startChunkedVoiceRecording,
} from "./chunkedRecorder";
import { startVoiceRecording } from "./recorder";
import { transcribeVoiceRecording } from "./transcriptionClient";

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
      finish: () => {
        recording.stop();
        return transcriber.finish();
      },
      cancel: () => {
        transcriber.cancel();
        recording.cancel();
      },
    };
  } catch (cause) {
    if (cause instanceof ChunkedRecordingUnavailableError) return startSingleClipSession();
    throw cause;
  }
}
