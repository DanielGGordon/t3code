/**
 * Sends the pieces of one recording to the server one at a time, in order, and stitches the text.
 * Each request carries the end of the text so far as context, so capitalisation and sentences
 * carry across the cuts; that is also why the pieces cannot go in parallel.
 */

const CONTEXT_CHARS = 200;

/** The end of `text` to pass along as context, starting at a whole word. */
export function contextTail(text: string): string {
  if (text.length <= CONTEXT_CHARS) return text;
  const tail = text.slice(-(CONTEXT_CHARS - 1));
  const firstSpace = tail.indexOf(" ");
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

export interface ChunkTranscript {
  /** The text of every piece that was transcribed, even if a later one failed. */
  readonly text: string;
  /** The failure that stopped the rest, if any. */
  readonly error: Error | null;
}

export interface ChunkTranscriberOptions {
  readonly transcribe: (wav: Blob, context: string) => Promise<string>;
  /** Tries per piece for errors that say `retryable`. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: (attempt: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ChunkTranscriber {
  /** Queues a piece. */
  readonly add: (wav: Blob) => void;
  /** Resolves once every queued piece is done; never rejects. */
  readonly finish: () => Promise<ChunkTranscript>;
  /** Stops sending; what is in flight is ignored. */
  readonly cancel: () => void;
}

export function createChunkTranscriber(options: ChunkTranscriberOptions): ChunkTranscriber {
  const maxAttempts = options.maxAttempts ?? 4;
  const retryDelayMs = options.retryDelayMs ?? ((attempt: number) => 1_500 * attempt);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let queue: Promise<void> = Promise.resolve();
  let text = "";
  let error: Error | null = null;
  let cancelled = false;

  const send = async (wav: Blob) => {
    for (let attempt = 1; ; attempt++) {
      if (cancelled || error !== null) return;
      try {
        const piece = (await options.transcribe(wav, contextTail(text))).trim();
        if (cancelled) return;
        if (piece.length > 0) text = text.length > 0 ? `${text} ${piece}` : piece;
        return;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error("Transcription failed.");
        if (cancelled) return;
        if (attempt >= maxAttempts || (cause as { retryable?: boolean }).retryable !== true) {
          // Later pieces would only fail the same way; keep what was transcribed so far.
          error = failure;
          return;
        }
        await sleep(retryDelayMs(attempt));
      }
    }
  };

  return {
    add: (wav) => {
      queue = queue.then(() => send(wav));
    },
    finish: async () => {
      await queue;
      return { text, error };
    },
    cancel: () => {
      cancelled = true;
    },
  };
}
