import { describe, expect, it } from "vite-plus/test";

import { PauseChunker, VOICE_SAMPLE_RATE } from "./pauseChunker";

const FRAME = 320; // 20 ms

/** A tone of `ms` at about -12 dBFS: speech to the chunker. */
function speech(ms: number): Int16Array {
  const samples = new Int16Array((VOICE_SAMPLE_RATE * ms) / 1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8_000 * Math.sin(i * 0.3));
  return samples;
}

const silence = (ms: number) => new Int16Array((VOICE_SAMPLE_RATE * ms) / 1000);

/** Feeds audio in uneven slices, like a capture callback would. */
function feed(chunker: PauseChunker, ...parts: Int16Array[]): Int16Array[] {
  const all = new Int16Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  const pieces: Int16Array[] = [];
  for (let start = 0; start < all.length; start += 1_000) {
    pieces.push(...chunker.push(all.subarray(start, start + 1_000)));
  }
  return pieces;
}

describe("PauseChunker", () => {
  it("cuts nothing out of silence", () => {
    const chunker = new PauseChunker();
    expect(feed(chunker, silence(10_000))).toEqual([]);
    expect(chunker.flush()).toBeNull();
  });

  it("cuts at the first 350 ms pause once the piece is 4 s long", () => {
    const chunker = new PauseChunker();
    const pieces = feed(chunker, speech(5_000), silence(400), speech(2_000));
    // 250 frames of speech, then the pause is complete after 17 silent frames (350 ms).
    expect(pieces.map((piece) => piece.length)).toEqual([(250 + 17) * FRAME]);
    // What follows the cut is the next piece.
    expect(chunker.flush()?.length).toBe((3 + 100) * FRAME);
  });

  it("does not cut at a pause before the piece is 4 s long, or at one shorter than 350 ms", () => {
    const chunker = new PauseChunker();
    expect(feed(chunker, speech(2_000), silence(600), speech(1_000))).toEqual([]);
    expect(feed(chunker, speech(3_000), silence(300), speech(2_000))).toEqual([]);
    expect(chunker.flush()?.length).toBe(
      (2_000 + 600 + 1_000 + 3_000 + 300 + 2_000) * (VOICE_SAMPLE_RATE / 1000),
    );
  });

  it("cuts at the quietest spot of the last 3 s when speech runs to 15 s", () => {
    const chunker = new PauseChunker();
    // A 40 ms dip at 12.5 s, inside the last 3 s of the first 15 s.
    const dipStartFrame = 625;
    const pieces = feed(chunker, speech(12_500), silence(40), speech(7_460));
    expect(pieces.length).toBe(1);
    expect(pieces[0]?.length).toBe((dipStartFrame + 2) * FRAME); // up to and including the last dip frame
    const rest = chunker.flush();
    expect((pieces[0]?.length ?? 0) + (rest?.length ?? 0)).toBe(VOICE_SAMPLE_RATE * 20);
  });

  it("drops a piece with less than 80 ms of speech", () => {
    const chunker = new PauseChunker();
    const click = speech(60);
    expect(feed(chunker, silence(4_000), click, silence(1_000))).toEqual([]);
    expect(chunker.flush()).toBeNull();
  });

  it("reports the loudest frame even when nothing counts as speech", () => {
    const chunker = new PauseChunker();
    expect(chunker.loudestDb).toBe(-90);
    feed(chunker, silence(500), speech(60), silence(500));
    expect(chunker.loudestDb).toBeCloseTo(20 * Math.log10(8_000 / 32_768), 0);
  });

  it("keeps a short word at the end of the recording", () => {
    const chunker = new PauseChunker();
    expect(feed(chunker, silence(1_000), speech(300))).toEqual([]);
    expect(chunker.flush()?.length).toBe(VOICE_SAMPLE_RATE * 1.3);
  });

  it("loses no audio across cuts", () => {
    const chunker = new PauseChunker();
    const input = [
      speech(6_000),
      silence(500),
      speech(9_000),
      speech(9_000),
      silence(800),
      speech(1_000),
    ];
    const pieces = feed(chunker, ...input);
    const last = chunker.flush();
    const heard = [...pieces, ...(last ? [last] : [])].reduce((n, piece) => n + piece.length, 0);
    expect(heard).toBe(input.reduce((n, part) => n + part.length, 0));
  });
});
