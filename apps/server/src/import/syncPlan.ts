/**
 * Pure planning logic for incremental Claude transcript sync: `create`, `append`, `unchanged`,
 * `skip-forked` (continued inside T3; appending would corrupt it) or `skip-deleted` (never resurrect,
 * including a stream that existed but lost its projection row). Dedup is an exact id-set check on
 * transcript uuids. Dependency-free (no Effect/T3 imports) so it can be extracted.
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

/** Thread id prefix used for threads created by the Claude transcript import. */
export const IMPORT_THREAD_ID_PREFIX = "claude-import-";

/** Minimal view of a provider session runtime binding (resume cursor owner). */
export interface ResumeBindingView {
  readonly threadId: string;
  /** Claude session id the binding's resume cursor points at, if any. */
  readonly resumeSessionId: string | null;
}

/**
 * Map of Claude session ids already owned by another T3 thread's resume binding (sessionId ->
 * threadId). Such a transcript must not be imported again: it is either a native session T3 spawned
 * or a forkSession continuation id. A binding to `claude-import-<sessionId>` is the mirror itself.
 */
export function buildOwnedSessionIdMap(
  bindings: Iterable<ResumeBindingView>,
): ReadonlyMap<string, string> {
  const owned = new Map<string, string>();
  for (const binding of bindings) {
    const sessionId = binding.resumeSessionId;
    if (sessionId === null || sessionId.trim().length === 0) continue;
    if (binding.threadId === `${IMPORT_THREAD_ID_PREFIX}${sessionId}`) continue;
    owned.set(sessionId, binding.threadId);
  }
  return owned;
}

/**
 * Fraction of a transcript's message uuids that must already belong to a
 * different thread before the transcript is treated as a fork copy. Forked
 * transcripts carry the full copied history, so real copies sit near 1.0; a
 * fork that diverged long ago (mostly new content) stays importable.
 */
export const COPY_SHARE_THRESHOLD = 0.5;

/**
 * Detect a fork-copy transcript: one whose messages largely already live on a DIFFERENT thread
 * (forkSession copies the whole history to a new session id; the cursor check only knows the latest
 * fork). Returns the majority owner when at least `COPY_SHARE_THRESHOLD` of messages belong to
 * another thread, else null.
 */
export function detectForkCopy(input: {
  readonly sessionMessages: ReadonlyArray<{ readonly uuid: string }>;
  /** Thread id the transcript would map to (`claude-import-<sessionId>`). */
  readonly threadId: string;
  readonly messageOwnerIndex: ReadonlyMap<string, string>;
}): { readonly ownerThreadId: string; readonly sharedRatio: number } | null {
  const { sessionMessages, threadId, messageOwnerIndex } = input;
  if (sessionMessages.length === 0) return null;
  const ownerCounts = new Map<string, number>();
  let shared = 0;
  for (const message of sessionMessages) {
    const owner = messageOwnerIndex.get(message.uuid);
    if (owner === undefined || owner === threadId) continue;
    shared += 1;
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
  }
  const sharedRatio = shared / sessionMessages.length;
  if (sharedRatio < COPY_SHARE_THRESHOLD) return null;
  let ownerThreadId: string | null = null;
  let best = 0;
  for (const [owner, count] of ownerCounts) {
    if (count > best) {
      best = count;
      ownerThreadId = owner;
    }
  }
  return ownerThreadId === null ? null : { ownerThreadId, sharedRatio };
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
