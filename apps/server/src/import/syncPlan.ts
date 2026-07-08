/**
 * Pure planning logic for incremental Claude transcript sync.
 *
 * Given a freshly parsed transcript and a view of the already-imported T3
 * thread (if any), decide what the importer should do:
 *
 *  - `create`: no thread yet — import everything.
 *  - `append`: thread exists and is still a pure import mirror — append only
 *    the transcript messages that have not been imported yet.
 *  - `unchanged`: thread exists and already contains every transcript message.
 *  - `skip-forked`: the thread has been continued inside T3 (it has provider
 *    turns, or messages that did not come from the import path). Appending
 *    original-session messages onto a forked thread would corrupt it, so the
 *    importer must permanently leave it alone.
 *  - `skip-deleted`: the thread was deleted in T3 — do not resurrect it.
 *    This covers BOTH a projection row with `deletedAt` set (the normal
 *    `thread.delete` soft delete) and a thread stream that EVER existed in
 *    `orchestration_events` but has no projection row anymore
 *    (`threadStreamEverExisted` tombstone — e.g. a purged or rebuilt
 *    projection). A deleted imported thread must stay deleted forever.
 *
 * Dedup strategy: imported messages use the transcript entry `uuid` as their
 * T3 message id (see `runImport` in `cli/import.ts`), so "already imported"
 * is an exact id-set membership check — no counters or timestamp cursors.
 *
 * Fork detection: imported messages always have `turnId === null` and ids
 * drawn from the transcript. Anything else on the thread (a latest turn, a
 * message bound to a turn, or a message id the transcript cannot explain)
 * can only have been produced by the normal T3 pipeline.
 *
 * This module is intentionally dependency-free (no Effect/T3 imports) so it
 * is trivially unit-testable, mirroring `claudeTranscript.ts`.
 */

import type { ParsedClaudeMessage, ParsedClaudeSession } from "./claudeTranscript.ts";

/** Minimal view of an already-imported message on the existing T3 thread. */
export interface ExistingThreadMessageView {
  readonly id: string;
  readonly turnId: string | null;
}

/** Minimal view of the existing T3 thread the session maps to. */
export interface ExistingThreadView {
  readonly deletedAt: string | null;
  /** True when the thread has any provider turn (read model `latestTurn`). */
  readonly hasTurns: boolean;
  readonly messages: ReadonlyArray<ExistingThreadMessageView>;
}

export type ThreadSyncPlan =
  | { readonly kind: "create"; readonly messages: ReadonlyArray<ParsedClaudeMessage> }
  | { readonly kind: "append"; readonly newMessages: ReadonlyArray<ParsedClaudeMessage> }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skip-deleted" }
  | { readonly kind: "skip-forked"; readonly reason: string };

export function planThreadSync(input: {
  readonly session: ParsedClaudeSession;
  readonly existingThread: ExistingThreadView | null;
  /**
   * Tombstone guard: true when the thread stream for this session has ANY
   * event in `orchestration_events`, regardless of the current projection.
   * When the projection row is gone (or was never rebuilt) but the stream
   * existed, the thread was deleted — creating it again would resurrect it.
   */
  readonly threadStreamEverExisted?: boolean;
}): ThreadSyncPlan {
  const { session, existingThread } = input;

  if (existingThread === null) {
    if (input.threadStreamEverExisted === true) {
      return { kind: "skip-deleted" };
    }
    return { kind: "create", messages: session.messages };
  }

  if (existingThread.deletedAt !== null) {
    return { kind: "skip-deleted" };
  }

  // Fork-safety guard: any evidence of the normal T3 pipeline means the
  // thread has diverged from the source transcript.
  if (existingThread.hasTurns) {
    return {
      kind: "skip-forked",
      reason: "thread has provider turns (it was continued in T3)",
    };
  }
  const turnBound = existingThread.messages.find((message) => message.turnId !== null);
  if (turnBound !== undefined) {
    return {
      kind: "skip-forked",
      reason: `message '${turnBound.id}' belongs to a turn (it was not imported)`,
    };
  }
  const transcriptIds = new Set(session.messages.map((message) => message.uuid));
  const foreign = existingThread.messages.find((message) => !transcriptIds.has(message.id));
  if (foreign !== undefined) {
    return {
      kind: "skip-forked",
      reason: `message '${foreign.id}' is not present in the source transcript`,
    };
  }

  const existingIds = new Set(existingThread.messages.map((message) => message.id));
  const newMessages = session.messages.filter((message) => !existingIds.has(message.uuid));
  if (newMessages.length === 0) {
    return { kind: "unchanged" };
  }
  return { kind: "append", newMessages };
}

/**
 * Prefixes of the first user prompt that identify "ralph" harness transcripts
 * (generator/evaluator/rescue loops) which should not be mirrored into T3.
 */
export const RALPH_PROMPT_PREFIXES: ReadonlyArray<string> = [
  "You are the generator agent",
  "You are the evaluator agent",
  "You are the rescue agent",
];

/** True when the session's first user message marks a ralph harness run. */
export function isRalphSession(session: ParsedClaudeSession): boolean {
  const firstUser = session.messages.find((message) => message.role === "user");
  if (firstUser === undefined) return false;
  const text = firstUser.text.trimStart();
  return RALPH_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}
