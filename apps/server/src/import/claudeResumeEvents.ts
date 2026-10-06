/**
 * Fork: shared building blocks for binding a v2 thread to an existing native
 * Claude session (`t3 import sync`, the legacy v1 resume restore, and
 * `t3 session reset`).
 *
 * The resume contract (see `ProviderTurnStartService.providerThreadHasImportedNativeHistory`):
 * a provider thread with a strong `nativeThreadRef` to Claude session X and
 * `firstRunOrdinal: null`, set as the thread's `activeProviderThreadId`, makes
 * the next T3 turn open Claude with `resume: X` (in place — Claude appends
 * T3's turns to X's transcript).
 */
import {
  EventId,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { deriveProviderThread } from "../orchestration-v2/IdAllocator.ts";

export const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** Thread id prefix used for threads created by the Claude transcript import. */
export const CLAUDE_IMPORT_THREAD_ID_PREFIX = "claude-import-";

const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude only resumes UUID session ids; anything else cannot be bound. */
export function isClaudeSessionId(value: string): boolean {
  return CLAUDE_SESSION_ID_PATTERN.test(value);
}

const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const decodeStoredThreadOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

/** Decode `orchestration_v2_projection_threads.payload_json`. */
export function decodeStoredAppThread(payloadJson: string): OrchestrationV2AppThread | undefined {
  return Option.getOrUndefined(decodeStoredThreadOption(payloadJson));
}

/**
 * Session id a legacy (v1) `provider_session_runtime.resume_cursor_json`
 * points at: `resume` (v1 Claude cursor) or `sessionId`. `undefined` for
 * unparseable / non-object cursors and blank values.
 */
export function readLegacyCursorSessionId(cursorJson: string | null): string | undefined {
  if (cursorJson === null) return undefined;
  const cursor = Option.getOrUndefined(decodeUnknownJsonString(cursorJson));
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const record = cursor as Record<string, unknown>;
  for (const key of ["resume", "sessionId"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Parse an ISO timestamp, falling back when it is blank or invalid. */
export function utcOr(value: string | null | undefined, fallback: DateTime.Utc): DateTime.Utc {
  if (value === null || value === undefined || value.trim().length === 0) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toUtc(parsed.value) : fallback;
}

/** The provider thread that makes T3 resume native Claude session `sessionId`. */
export function importedClaudeProviderThread(input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly at: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: deriveProviderThread({ driver: CLAUDE_DRIVER_KIND, nativeThreadId: input.sessionId }),
    driver: CLAUDE_DRIVER_KIND,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE_DRIVER_KIND, nativeId: input.sessionId, strength: "strong" },
    // Do not pin a head: it would become `resumeSessionAt`.
    nativeConversationHeadRef: null,
    status: "idle",
    // The "imported native history" marker; T3 sets it on its first turn.
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/**
 * Events binding an EXISTING thread to native Claude session `sessionId`:
 * the provider thread plus a metadata update pointing the app thread at it.
 * Timestamps reuse the thread's own `updatedAt` so the bind does not reorder
 * the sidebar.
 */
export function bindExistingThreadToClaudeSession(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly sessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly eventIdPrefix: string;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const at = input.thread.updatedAt;
  const providerThread = importedClaudeProviderThread({
    threadId: input.thread.id,
    sessionId: input.sessionId,
    providerInstanceId: input.providerInstanceId,
    at,
  });
  return [
    {
      id: EventId.make(`${input.eventIdPrefix}:provider-thread`),
      type: "provider-thread.updated",
      threadId: input.thread.id,
      driver: CLAUDE_DRIVER_KIND,
      providerInstanceId: input.providerInstanceId,
      occurredAt: at,
      payload: providerThread,
    },
    {
      id: EventId.make(`${input.eventIdPrefix}:thread`),
      type: "thread.metadata-updated",
      threadId: input.thread.id,
      providerInstanceId: input.thread.providerInstanceId,
      occurredAt: at,
      payload: { ...input.thread, activeProviderThreadId: providerThread.id },
    },
  ];
}
