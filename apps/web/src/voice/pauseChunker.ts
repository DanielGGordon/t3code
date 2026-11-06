/**
 * Cuts a live 16 kHz recording at pauses so each piece can be transcribed while the user talks;
 * same rules as `dictate.ahk` (transcription-service). Speech = a 20 ms frame 12 dB above the last
 * 2 s' quietest, clamped to -52..-30 dBFS. Pieces with under 80 ms of speech are dropped.
 */

export const VOICE_SAMPLE_RATE = 16_000;

const FRAME_SAMPLES = 320; // 20 ms
const FRAME_MS = 20;
const MIN_SPEECH_FRAMES = 4;
const NOISE_WINDOW_FRAMES = 100; // 2 s
const FORCED_CUT_WINDOW_FRAMES = 150; // 3 s
const NOISE_MARGIN_DB = 12;
const SPEECH_THRESHOLD_FLOOR_DB = -52;
const SPEECH_THRESHOLD_CEILING_DB = -30;

export interface PauseChunkerOptions {
  readonly minChunkMs?: number;
  readonly maxChunkMs?: number;
  readonly pauseMs?: number;
}

const DEFAULT_PAUSE_CHUNKER_OPTIONS = {
  minChunkMs: 4_000,
  maxChunkMs: 15_000,
  pauseMs: 350,
} as const satisfies Required<PauseChunkerOptions>;

export class PauseChunker {
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private readonly pauseFrames: number;
  private pcm = new Int16Array(VOICE_SAMPLE_RATE * 20);
  private length = 0;
  /** Peak level of each analysed frame of the piece being collected. */
  private readonly levels: number[] = [];
  private readonly voiced: boolean[] = [];
  /** The last second or two of levels, kept across cuts to estimate the room's noise. */
  private readonly recent: number[] = [];
  private silent = 0;

  constructor(options: PauseChunkerOptions = {}) {
    const { minChunkMs, maxChunkMs, pauseMs } = { ...DEFAULT_PAUSE_CHUNKER_OPTIONS, ...options };
    this.minFrames = Math.floor(minChunkMs / FRAME_MS);
    this.maxFrames = Math.max(this.minFrames, Math.floor(maxChunkMs / FRAME_MS));
    this.pauseFrames = Math.max(1, Math.floor(pauseMs / FRAME_MS));
  }

  /** Adds audio; returns the pieces that were completed by it, in order. */
  push(samples: Int16Array): Int16Array[] {
    if (this.length + samples.length > this.pcm.length) {
      const grown = new Int16Array(Math.max(this.pcm.length * 2, this.length + samples.length));
      grown.set(this.pcm.subarray(0, this.length));
      this.pcm = grown;
    }
    this.pcm.set(samples, this.length);
    this.length += samples.length;

    const pieces: Int16Array[] = [];
    while (this.length - this.levels.length * FRAME_SAMPLES >= FRAME_SAMPLES) {
      const piece = this.analyseNextFrame();
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  /** The recording is over: whatever is left since the last cut, or null if it holds no speech. */
  flush(): Int16Array | null {
    return this.cut(this.levels.length, true) ?? null;
  }

  private analyseNextFrame(): Int16Array | undefined {
    const start = this.levels.length * FRAME_SAMPLES;
    let peak = 0;
    for (let i = start; i < start + FRAME_SAMPLES; i++) {
      const value = Math.abs(this.pcm[i] ?? 0);
      if (value > peak) peak = value;
    }
    const level = peak < 2 ? -90 : 20 * Math.log10(peak / 32_768);
    this.levels.push(level);
    this.recent.push(level);
    if (this.recent.length > NOISE_WINDOW_FRAMES) this.recent.shift();
    let floor = level;
    for (const value of this.recent) if (value < floor) floor = value;
    const voiced =
      level >=
      Math.min(
        SPEECH_THRESHOLD_CEILING_DB,
        Math.max(SPEECH_THRESHOLD_FLOOR_DB, floor + NOISE_MARGIN_DB),
      );
    this.voiced.push(voiced);
    this.silent = voiced ? 0 : this.silent + 1;

    const frames = this.levels.length;
    if (frames >= this.maxFrames) {
      let best = frames - 1;
      for (let i = frames - 1; i >= Math.max(0, frames - FORCED_CUT_WINDOW_FRAMES); i--) {
        if ((this.levels[i] ?? 0) < (this.levels[best] ?? 0)) best = i;
      }
      return this.cut(best + 1, false);
    }
    if (frames >= this.minFrames && this.silent >= this.pauseFrames) return this.cut(frames, false);
    return undefined;
  }

  /** Ends the piece after `frames` frames; returns it if it holds speech. `last` takes the partial frame at the end too. */
  private cut(frames: number, last: boolean): Int16Array | undefined {
    let speech = 0;
    for (let i = 0; i < frames; i++) if (this.voiced[i]) speech += 1;
    const stop = last ? this.length : frames * FRAME_SAMPLES;
    const piece = speech >= MIN_SPEECH_FRAMES ? this.pcm.slice(0, stop) : undefined;

    this.pcm.copyWithin(0, stop, this.length);
    this.length -= stop;
    this.levels.splice(0, frames);
    this.voiced.splice(0, frames);
    this.silent = 0;
    for (let i = this.voiced.length - 1; i >= 0 && !this.voiced[i]; i--) this.silent += 1;
    return piece;
  }
}
