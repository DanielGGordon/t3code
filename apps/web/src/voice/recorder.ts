/**
 * Thin wrapper over getUserMedia + MediaRecorder for one voice clip.
 */

/** Containers in preference order; every one is accepted by the transcriber. */
const PREFERRED_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export function pickVoiceRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | undefined {
  return PREFERRED_RECORDING_MIME_TYPES.find((mimeType) => {
    try {
      return isTypeSupported(mimeType);
    } catch {
      return false;
    }
  });
}

/** Microphone capture needs a secure context plus both browser APIs. */
export function isVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export interface VoiceRecording {
  /** Stop recording and resolve with the captured audio. */
  readonly stop: () => Promise<Blob>;
  /** Stop recording and discard the audio. */
  readonly cancel: () => void;
}

/** A failure starting the microphone; `message` is safe to show the user. */
export class VoiceRecordingStartError extends Error {
  override readonly name = "VoiceRecordingStartError";
}

function describeStartFailure(cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow it in the browser's site settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError") {
    return "The microphone is in use by another app.";
  }
  return "Could not start the microphone.";
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    throw new VoiceRecordingStartError(describeStartFailure(cause), { cause });
  }
  const releaseMicrophone = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  let recorder: MediaRecorder;
  try {
    const mimeType = pickVoiceRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (cause) {
    releaseMicrophone();
    throw new VoiceRecordingStartError("This browser cannot record audio.", { cause });
  }

  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  // A timeslice makes long recordings flush incrementally instead of in one
  // final buffer.
  recorder.start(1_000);

  const stopRecorder = () => {
    if (recorder.state !== "inactive") recorder.stop();
    releaseMicrophone();
  };

  return {
    stop: async () => {
      stopRecorder();
      await stopped;
      return new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
    },
    cancel: () => {
      stopRecorder();
      chunks.length = 0;
    },
  };
}
