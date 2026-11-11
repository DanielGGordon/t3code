/** Sample-format helpers for the voice recorder: downsampling to 16 kHz and WAV packaging. */
import { VOICE_SAMPLE_RATE } from "./pauseChunker";

/**
 * Streaming downsampler from the microphone's rate (usually 48 or 44.1 kHz) to 16 kHz mono 16-bit.
 * Every output sample is the average of the input it covers, which is enough of a low-pass for
 * speech. Keeps its partial output sample between calls.
 */
export class Resampler {
  private readonly ratio: number;
  private sum = 0;
  private filled = 0;

  constructor(
    inputRate: number,
    private readonly outputRate = VOICE_SAMPLE_RATE,
  ) {
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Int16Array {
    if (this.ratio === 1) return Int16Array.from(input, floatToInt16);
    const output: number[] = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.filled);
        this.sum += sample * take;
        this.filled += take;
        remaining -= take;
        if (this.filled >= this.ratio - 1e-9) {
          output.push(floatToInt16(this.sum / this.ratio));
          this.sum = 0;
          this.filled = 0;
        }
      }
    }
    return Int16Array.from(output);
  }
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
}

/** A 16-bit mono PCM WAV file. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate = VOICE_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return bytes;
}
