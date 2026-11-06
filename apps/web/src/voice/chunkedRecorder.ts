/**
 * Microphone capture that hands over finished WAV pieces while the user is still talking.
 * MediaRecorder slices are not playable on their own, so this captures raw audio with Web Audio
 * (an AudioWorklet, or a ScriptProcessor without worklets), downsamples to 16 kHz and cuts at pauses.
 */
import { PauseChunker, type PauseChunkerOptions } from "./pauseChunker";
import { encodeWav, Resampler } from "./pcm";
import { describeStartFailure, VoiceRecordingStartError } from "./recorder";

const WORKLET_NAME = "t3-pcm-capture";
// Batches ~21 ms of audio per message; the processor runs every 2.7 ms and would flood the port.
const WORKLET_SOURCE = `
class T3PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.length = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.length++] = channel[i];
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(1024);
          this.length = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", T3PcmCapture);
`;

/** The audio graph could not be set up (the microphone itself is fine); the caller can record the old way. */
export class ChunkedRecordingUnavailableError extends Error {
  override readonly name = "ChunkedRecordingUnavailableError";
}

export interface ChunkedVoiceRecording {
  /** Stop capturing and hand over the last piece, if it holds speech. */
  readonly stop: () => void;
  /** Stop capturing and drop what is left. */
  readonly cancel: () => void;
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof AudioContext !== "undefined") return AudioContext;
  return (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** Microphone capture needs a secure context; piece-wise capture also needs Web Audio. */
export function isChunkedVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    audioContextConstructor() !== undefined
  );
}

export async function startChunkedVoiceRecording(
  onPiece: (wav: Blob) => void,
  chunkerOptions?: PauseChunkerOptions,
): Promise<ChunkedVoiceRecording> {
  const Context = audioContextConstructor();
  if (!Context) throw new ChunkedRecordingUnavailableError("Web Audio is not available.");
  // Created before the permission prompt so it starts inside the user's click.
  const context = new Context();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    void context.close();
    throw new VoiceRecordingStartError(describeStartFailure(cause), { cause });
  }

  const resampler = new Resampler(context.sampleRate);
  const chunker = new PauseChunker(chunkerOptions);
  let active = true;
  const handleSamples = (samples: Float32Array) => {
    if (!active) return;
    const pcm = resampler.process(samples);
    for (const piece of chunker.push(pcm))
      onPiece(new Blob([encodeWav(piece)], { type: "audio/wav" }));
  };

  const cleanups: Array<() => void> = [];
  const release = () => {
    active = false;
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // already torn down
      }
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };

  try {
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    // A node only runs while it is connected to the destination; the silent gain keeps the
    // microphone from playing back through the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    mute.connect(context.destination);
    cleanups.push(() => mute.disconnect());
    cleanups.push(() => source.disconnect());

    if (context.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, WORKLET_NAME);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => handleSamples(event.data);
      source.connect(node);
      node.connect(mute);
      cleanups.push(() => node.disconnect());
    } else {
      const node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => handleSamples(event.inputBuffer.getChannelData(0).slice());
      source.connect(node);
      node.connect(mute);
      cleanups.push(() => {
        node.onaudioprocess = null;
        node.disconnect();
      });
    }
  } catch (cause) {
    release();
    throw new ChunkedRecordingUnavailableError("Could not set up Web Audio capture.", { cause });
  }

  return {
    stop: () => {
      if (!active) return;
      release();
      const last = chunker.flush();
      if (last) onPiece(new Blob([encodeWav(last)], { type: "audio/wav" }));
    },
    cancel: () => {
      if (active) release();
    },
  };
}
