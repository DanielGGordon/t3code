import { describe, expect, it } from "vite-plus/test";

import { encodeWav, Resampler } from "./pcm";

describe("Resampler", () => {
  it("averages 48 kHz down to 16 kHz", () => {
    const output = new Resampler(48_000).process(new Float32Array(4_800).fill(0.5));
    expect(output.length).toBe(1_600);
    expect(output[0]).toBe(16_384);
  });

  it("keeps the rate right for 44.1 kHz and across uneven slices", () => {
    const whole = new Resampler(44_100).process(new Float32Array(44_100));
    expect(Math.abs(whole.length - 16_000)).toBeLessThanOrEqual(1);

    const sliced = new Resampler(44_100);
    const lengths = [441, 1_000, 3_000, 39_659].map(
      (n) => sliced.process(new Float32Array(n)).length,
    );
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(whole.length);
  });

  it("passes 16 kHz through and clips out-of-range samples", () => {
    expect([...new Resampler(16_000).process(Float32Array.of(0, 1, -1, 2, -2))]).toEqual([
      0, 32_767, -32_768, 32_767, -32_768,
    ]);
  });
});

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM header and the samples", () => {
    const bytes = encodeWav(Int16Array.of(1, -2, 3));
    const view = new DataView(bytes.buffer);
    const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect([view.getUint16(20, true), view.getUint16(22, true)]).toEqual([1, 1]);
    expect([view.getUint32(24, true), view.getUint32(28, true)]).toEqual([16_000, 32_000]);
    expect([view.getUint16(32, true), view.getUint16(34, true)]).toEqual([2, 16]);
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([
      1, -2, 3,
    ]);
    expect(bytes.length).toBe(50);
  });
});
