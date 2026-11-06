import { describe, expect, it } from "vite-plus/test";

import { contextTail, createChunkTranscriber } from "./chunkTranscriber";

const wav = (n: number) => new Blob([new Uint8Array([n])], { type: "audio/wav" });
const retryable = () => Object.assign(new Error("busy"), { retryable: true });

describe("contextTail", () => {
  it("keeps short text and cuts long text to its last words", () => {
    expect(contextTail("hello there")).toBe("hello there");
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const tail = contextTail(long);
    expect(tail.length).toBeLessThanOrEqual(200);
    expect(long.endsWith(tail)).toBe(true);
    expect(tail).toMatch(/^w\d+/);
  });
});

describe("createChunkTranscriber", () => {
  it("sends pieces one at a time, in order, each with the text so far", async () => {
    const calls: Array<{ piece: number; context: string; running: number }> = [];
    let running = 0;
    const transcriber = createChunkTranscriber({
      transcribe: async (blob, context) => {
        const piece = new Uint8Array(await blob.arrayBuffer())[0] ?? 0;
        running += 1;
        calls.push({ piece, context, running });
        await Promise.resolve();
        running -= 1;
        return `part ${piece}.`;
      },
    });
    transcriber.add(wav(1));
    transcriber.add(wav(2));
    transcriber.add(wav(3));
    expect(await transcriber.finish()).toEqual({ text: "part 1. part 2. part 3.", error: null });
    expect(calls).toEqual([
      { piece: 1, context: "", running: 1 },
      { piece: 2, context: "part 1.", running: 1 },
      { piece: 3, context: "part 1. part 2.", running: 1 },
    ]);
  });

  it("retries a busy server and then carries on", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const transcriber = createChunkTranscriber({
      transcribe: async () => {
        attempts += 1;
        if (attempts < 3) throw retryable();
        return "ok";
      },
      sleep: async (ms) => void slept.push(ms),
      retryDelayMs: (attempt) => attempt * 10,
    });
    transcriber.add(wav(1));
    expect(await transcriber.finish()).toEqual({ text: "ok", error: null });
    expect(slept).toEqual([10, 20]);
  });

  it("keeps the text that worked and skips the rest after a failure that will not pass", async () => {
    let calls = 0;
    const transcriber = createChunkTranscriber({
      transcribe: async () => {
        calls += 1;
        if (calls === 2) throw new Error("No key set.");
        return `text ${calls}`;
      },
      sleep: async () => {},
    });
    transcriber.add(wav(1));
    transcriber.add(wav(2));
    transcriber.add(wav(3));
    const { text, error } = await transcriber.finish();
    expect(text).toBe("text 1");
    expect(error?.message).toBe("No key set.");
    expect(calls).toBe(2);
  });

  it("gives up after the attempts are used", async () => {
    let calls = 0;
    const transcriber = createChunkTranscriber({
      transcribe: async () => {
        calls += 1;
        throw retryable();
      },
      maxAttempts: 3,
      sleep: async () => {},
    });
    transcriber.add(wav(1));
    expect((await transcriber.finish()).error?.message).toBe("busy");
    expect(calls).toBe(3);
  });

  it("sends nothing more once cancelled", async () => {
    let calls = 0;
    const transcriber = createChunkTranscriber({
      transcribe: async () => {
        calls += 1;
        return "x";
      },
    });
    transcriber.cancel();
    transcriber.add(wav(1));
    expect(await transcriber.finish()).toEqual({ text: "", error: null });
    expect(calls).toBe(0);
  });
});
