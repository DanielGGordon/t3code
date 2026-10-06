/**
 * Fork: mirror Claude Code transcripts (`~/.claude/projects/<cwd>/<id>.jsonl`)
 * into T3 as backdated, resumable v2 threads (`t3 import sync|claude`).
 *
 * Each session maps to thread `claude-import-<sessionId>`. Creation writes v2
 * events directly (same shapes as upstream's `AgentSessionImporter`):
 * `thread.created` (`historyOrigin: "v1_import"`, settled), one
 * `message.updated` + `turn-item.updated` per transcript message (message id =
 * transcript uuid, so dedupe and fork-copy detection are id-set checks), and a
 * `provider-thread.updated` binding the thread to the native session so the
 * first T3 send resumes it in place (see `claudeResumeEvents.ts`).
 *
 * Guards (all re-sourced from the v2 tables):
 *  - tombstones: a thread stream that ever existed but has no live projection
 *    row is never recreated; a projection row with `deleted_at` stays deleted.
 *  - skipped-owned: the session id is the native session of another thread
 *    (v2 provider threads, or a legacy v1 resume cursor).
 *  - skipped-worktree: the transcript cwd is inside T3's worktrees dir.
 *  - skipped-copy: most of the transcript's message uuids already live on
 *    another thread (a forkSession copy).
 *  - skipped-forked: T3 has run turns in the thread (or it holds messages the
 *    transcript cannot explain) — resume is in place, so Claude appends T3's
 *    own turns to the transcript and mirroring them again would duplicate.
 *
 * In production this runs inside the serving process (`POST
 * /api/fork/import/claude-sync`, see `fork/http.ts`) so events reach live
 * clients; the CLI only falls back to running it in-process when no server
 * is running.
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  defaultInstanceIdForDriver,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type ParsedClaudeMessage,
  type ParsedClaudeSession,
  parseClaudeTranscript,
} from "./claudeTranscript.ts";
import {
  bindExistingThreadToClaudeSession,
  CLAUDE_DRIVER_KIND,
  CLAUDE_IMPORT_THREAD_ID_PREFIX,
  decodeStoredAppThread,
  importedClaudeProviderThread,
  isClaudeSessionId,
  readLegacyCursorSessionId,
  utcOr,
} from "./claudeResumeEvents.ts";
import {
  buildOwnedSessionIdMap,
  detectForkCopy,
  isRalphSession,
  planThreadSync,
  type ResumeBindingView,
} from "./syncPlan.ts";

const IMPORT_EVENT_PREFIX = "claude-import:v2";
const MESSAGE_BATCH_SIZE = 50;
const IMPORTED_THREAD_FALLBACK_TITLE = "Imported Claude session";
const DEFAULT_PROJECTS_DIR = "~/.claude/projects";

export class ClaudeImportError extends Schema.TaggedError<ClaudeImportError>()(
  "ClaudeImportError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new ClaudeImportError({ detail }));
const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
const mapFailure =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) => new ClaudeImportError({ detail: `${what}: ${describe(cause)}` }),
    );

/** Flags shared by `t3 import sync` and `t3 import claude` (also the route body). */
export const ClaudeImportOptions = Schema.Struct({
  /** claudeAgent provider instance to attribute imported threads to. */
  instance: Schema.optional(Schema.String),
  /** Transcript root; defaults to `~/.claude/projects` of the serving user. */
  projectsDir: Schema.optional(Schema.String),
  /** Also mirror ralph harness transcripts. */
  includeRalph: Schema.optional(Schema.Boolean),
});
export type ClaudeImportOptions = typeof ClaudeImportOptions.Type;

export interface ClaudeSyncCounters {
  created: number;
  updated: number;
  appended: number;
  unchanged: number;
  skippedForked: number;
  skippedRalph: number;
  skippedEmpty: number;
  skippedDeleted: number;
  skippedOwned: number;
  skippedWorktree: number;
  skippedCopy: number;
  skippedPendingMigration: number;
  skippedMissingCwd: number;
  failed: number;
  total: number;
}

export interface ClaudeImportReport {
  readonly lines: ReadonlyArray<string>;
  readonly counters: ClaudeSyncCounters;
}

/** Outcome of a create-or-incremental-update pass for one session. */
export type ClaudeSessionOutcome =
  | {
      readonly kind: "created";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly imported: number;
      readonly reusedProject: boolean;
    }
  | { readonly kind: "updated"; readonly threadId: ThreadId; readonly appended: number }
  | { readonly kind: "unchanged"; readonly threadId: ThreadId; readonly rebound: boolean }
  | { readonly kind: "skipped-deleted"; readonly threadId: ThreadId }
  | { readonly kind: "skipped-forked"; readonly threadId: ThreadId; readonly reason: string }
  | { readonly kind: "skipped-owned"; readonly ownerThreadId: string }
  | { readonly kind: "skipped-copy"; readonly ownerThreadId: string; readonly sharedRatio: number }
  | { readonly kind: "skipped-pending-migration"; readonly threadId: ThreadId }
  | { readonly kind: "skipped-missing-cwd"; readonly cwd: string };

export function emptyCounters(): ClaudeSyncCounters {
  return {
    created: 0,
    updated: 0,
    appended: 0,
    unchanged: 0,
    skippedForked: 0,
    skippedRalph: 0,
    skippedEmpty: 0,
    skippedDeleted: 0,
    skippedOwned: 0,
    skippedWorktree: 0,
    skippedCopy: 0,
    skippedPendingMigration: 0,
    skippedMissingCwd: 0,
    failed: 0,
    total: 0,
  };
}

export function formatSummary(counters: ClaudeSyncCounters): string {
  return (
    `summary created=${counters.created} updated=${counters.updated} appended=${counters.appended} ` +
    `unchanged=${counters.unchanged} skipped-forked=${counters.skippedForked} ` +
    `skipped-ralph=${counters.skippedRalph} skipped-empty=${counters.skippedEmpty} ` +
    `skipped-deleted=${counters.skippedDeleted} skipped-owned=${counters.skippedOwned} ` +
    `skipped-worktree=${counters.skippedWorktree} skipped-copy=${counters.skippedCopy} ` +
    `skipped-pending-migration=${counters.skippedPendingMigration} ` +
    `skipped-missing-cwd=${counters.skippedMissingCwd} ` +
    `failed=${counters.failed} total=${counters.total}`
  );
}

/** One machine-readable line per session, and the matching counter bump. */
export function recordOutcome(
  counters: ClaudeSyncCounters,
  sessionId: string,
  outcome: ClaudeSessionOutcome,
): string {
  switch (outcome.kind) {
    case "created":
      counters.created += 1;
      return `created sessionId=${sessionId} messages=${outcome.imported}`;
    case "updated":
      counters.updated += 1;
      counters.appended += outcome.appended;
      return `updated sessionId=${sessionId} appended=${outcome.appended}`;
    case "unchanged":
      counters.unchanged += 1;
      return `unchanged sessionId=${sessionId}${outcome.rebound ? " resume=rebound" : ""}`;
    case "skipped-deleted":
      counters.skippedDeleted += 1;
      return `skipped-deleted sessionId=${sessionId}`;
    case "skipped-forked":
      counters.skippedForked += 1;
      return `skipped-forked sessionId=${sessionId} reason=${outcome.reason}`;
    case "skipped-owned":
      counters.skippedOwned += 1;
      return `skipped-owned sessionId=${sessionId} ownerThreadId=${outcome.ownerThreadId}`;
    case "skipped-copy":
      counters.skippedCopy += 1;
      return (
        `skipped-copy sessionId=${sessionId} ownerThreadId=${outcome.ownerThreadId} ` +
        `shared=${Math.round(outcome.sharedRatio * 100)}%`
      );
    case "skipped-pending-migration":
      counters.skippedPendingMigration += 1;
      return `skipped-pending-migration sessionId=${sessionId} threadId=${outcome.threadId}`;
    case "skipped-missing-cwd":
      counters.skippedMissingCwd += 1;
      return `skipped-missing-cwd sessionId=${sessionId} cwd=${outcome.cwd}`;
  }
}

interface ExistingImportThread {
  readonly payloadJson: string;
  readonly deletedAt: string | null;
  readonly activeProviderThreadId: string | null;
}

/** Database view loaded once per sweep and updated in memory as we write. */
interface SyncState {
  readonly threads: Map<string, ExistingImportThread>;
  readonly threadsWithRuns: Set<string>;
  readonly threadsWithProviderThreads: Set<string>;
  readonly tombstones: Set<string>;
  readonly pendingLegacyTranscripts: Set<string>;
  readonly messageOwnerIndex: Map<string, string>;
  readonly importThreadMessages: Map<string, Array<{ id: string; runId: string | null }>>;
  readonly ownedSessionIds: ReadonlyMap<string, string>;
  readonly projectsByRoot: Map<string, ProjectId>;
}

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly message: ParsedClaudeMessage;
  readonly fallbackAt: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, message } = input;
  const messageId = MessageId.make(message.uuid);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${message.uuid}`,
  );
  const at = utcOr(message.timestamp, input.fallbackAt);
  const conversationMessage: OrchestrationV2ConversationMessage = {
    createdBy: message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: message.role,
    text: message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    // Positions for run-less items are allocated in write order (EventSink).
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${threadId}:${message.uuid}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: conversationMessage,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${message.uuid}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

export interface ClaudeTranscriptSyncShape {
  /** Sweep every transcript under the projects dir (`t3 import sync`). */
  readonly sync: (
    options: ClaudeImportOptions,
  ) => Effect.Effect<ClaudeImportReport, ClaudeImportError>;
  /** Import one transcript by path or session id (`t3 import claude`). */
  readonly importSession: (
    options: ClaudeImportOptions & { readonly session: string },
  ) => Effect.Effect<ClaudeImportReport, ClaudeImportError>;
}

export class ClaudeTranscriptSync extends Context.Service<
  ClaudeTranscriptSync,
  ClaudeTranscriptSyncShape
>()("t3/import/ClaudeTranscriptSync") {}

interface CachedFileOutcome {
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly outcome: ClaudeSessionOutcome;
}

/** Outcomes that cannot change while the transcript file itself is unchanged. */
function isStableOutcome(outcome: ClaudeSessionOutcome): boolean {
  switch (outcome.kind) {
    case "unchanged":
    case "skipped-deleted":
    case "skipped-forked":
    case "skipped-owned":
    case "skipped-copy":
      return true;
    default:
      return false;
  }
}

/**
 * A cached outcome is only reused while the database still agrees with it;
 * otherwise the transcript is parsed and planned again.
 */
function cachedOutcomeStillHolds(state: SyncState, cached: CachedFileOutcome): boolean {
  const outcome = cached.outcome;
  switch (outcome.kind) {
    case "unchanged": {
      const thread = state.threads.get(outcome.threadId);
      return (
        thread !== undefined &&
        thread.deletedAt === null &&
        !state.threadsWithRuns.has(outcome.threadId) &&
        !state.pendingLegacyTranscripts.has(outcome.threadId) &&
        // Not `activeProviderThreadId`: it can dangle (see ensureResumable).
        state.threadsWithProviderThreads.has(outcome.threadId)
      );
    }
    case "skipped-owned":
      return state.ownedSessionIds.get(cached.sessionId) === outcome.ownerThreadId;
    case "skipped-deleted":
    case "skipped-forked":
    case "skipped-copy":
      // Deletion and T3 turns are permanent; a copy only matters at creation.
      return true;
    default:
      return false;
  }
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A long-lived server re-sweeps every 15 minutes; skip re-parsing files whose
  // size+mtime did not change since an outcome that only a file change can alter.
  const fileOutcomeCache = new Map<string, CachedFileOutcome>();
  const sweepLock = yield* Semaphore.make(1);

  const claudeModel = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND] ?? "claude-sonnet-5";

  const resolveInstanceId = Effect.fn("ClaudeTranscriptSync.resolveInstanceId")(function* (
    explicit: string | undefined,
  ) {
    const current = yield* settings.getSettings.pipe(mapFailure("Failed to read server settings"));
    const claudeInstanceIds = Object.entries(current.providerInstances)
      .filter(([, instance]) => instance.driver === CLAUDE_DRIVER_KIND)
      .map(([id]) => ProviderInstanceId.make(id));
    const defaultId = defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
    if (explicit !== undefined && explicit.trim().length > 0) {
      const requested = ProviderInstanceId.make(explicit.trim());
      // The canonical default is hydrated from legacy settings even when it is
      // not materialized in providerInstances.
      if (!claudeInstanceIds.includes(requested) && requested !== defaultId) {
        return yield* fail(
          `--instance '${requested}' is not a configured claudeAgent provider instance.`,
        );
      }
      return requested;
    }
    if (claudeInstanceIds.length === 1) return claudeInstanceIds[0]!;
    if (claudeInstanceIds.length === 0) return defaultId;
    return yield* fail(
      "Multiple claudeAgent provider instances are configured. " +
        `Pass --instance with one of: ${claudeInstanceIds.join(", ")}.`,
    );
  });

  const loadState = Effect.gen(function* () {
    const prefix = `${CLAUDE_IMPORT_THREAD_ID_PREFIX}%`;
    const threadRows = yield* sql<{
      readonly thread_id: string;
      readonly deleted_at: string | null;
      readonly active_provider_thread_id: string | null;
      readonly payload_json: string;
    }>`
      SELECT thread_id, deleted_at, active_provider_thread_id, payload_json
      FROM orchestration_v2_projection_threads
      WHERE thread_id LIKE ${prefix}
    `;
    const runRows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE thread_id LIKE ${prefix}
    `;
    // The event log is append-only: a stream that ever existed is a permanent
    // tombstone once its live projection row is gone.
    const streamRows = yield* sql<{ readonly stream_id: string }>`
      SELECT DISTINCT stream_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id LIKE ${prefix}
    `;
    const pendingRows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NULL AND thread_id LIKE ${prefix}
    `;
    const messageRows = yield* sql<{
      readonly message_id: string;
      readonly thread_id: string;
      readonly run_id: string | null;
    }>`
      SELECT message_id, thread_id, run_id FROM orchestration_v2_projection_messages
    `;
    const providerThreadRows = yield* sql<{
      readonly thread_id: string | null;
      readonly native_id: string | null;
    }>`
      SELECT thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
      FROM orchestration_v2_projection_provider_threads
      WHERE driver = ${CLAUDE_DRIVER_KIND}
    `;
    const legacyRuntimeRows = yield* sql<{
      readonly thread_id: string;
      readonly resume_cursor_json: string | null;
    }>`
      SELECT thread_id, resume_cursor_json
      FROM provider_session_runtime
      WHERE provider_name = ${CLAUDE_DRIVER_KIND}
    `;

    const messageOwnerIndex = new Map<string, string>();
    const importThreadMessages = new Map<string, Array<{ id: string; runId: string | null }>>();
    for (const row of messageRows) {
      messageOwnerIndex.set(row.message_id, row.thread_id);
      if (row.thread_id.startsWith(CLAUDE_IMPORT_THREAD_ID_PREFIX)) {
        const list = importThreadMessages.get(row.thread_id) ?? [];
        list.push({ id: row.message_id, runId: row.run_id });
        importThreadMessages.set(row.thread_id, list);
      }
    }

    const bindings: Array<ResumeBindingView> = [
      ...legacyRuntimeRows.map((row) => ({
        threadId: row.thread_id,
        resumeSessionId: readLegacyCursorSessionId(row.resume_cursor_json) ?? null,
      })),
      // v2 provider threads last: they are the live truth when both exist.
      ...providerThreadRows.flatMap((row) =>
        row.thread_id === null ? [] : [{ threadId: row.thread_id, resumeSessionId: row.native_id }],
      ),
    ];

    const snapshot = yield* projects.snapshot;
    const projectsByRoot = new Map<string, ProjectId>();
    for (const project of snapshot.projects) {
      if (project.deletedAt === null) projectsByRoot.set(project.workspaceRoot, project.id);
    }

    return {
      threads: new Map(
        threadRows.map((row) => [
          row.thread_id,
          {
            payloadJson: row.payload_json,
            deletedAt: row.deleted_at,
            activeProviderThreadId: row.active_provider_thread_id,
          },
        ]),
      ),
      threadsWithRuns: new Set(runRows.map((row) => row.thread_id)),
      threadsWithProviderThreads: new Set(
        providerThreadRows.flatMap((row) => (row.thread_id === null ? [] : [row.thread_id])),
      ),
      tombstones: new Set(streamRows.map((row) => row.stream_id)),
      pendingLegacyTranscripts: new Set(pendingRows.map((row) => row.thread_id)),
      messageOwnerIndex,
      importThreadMessages,
      ownedSessionIds: buildOwnedSessionIdMap(bindings),
      projectsByRoot,
    } satisfies SyncState;
  }).pipe(mapFailure("Failed to read the T3 state for the import"));

  const writeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    eventSink.write({ events }).pipe(mapFailure("Failed to write import events"), Effect.asVoid);

  const resolveProject = Effect.fn("ClaudeTranscriptSync.resolveProject")(function* (
    state: SyncState,
    session: ParsedClaudeSession,
    workspaceRoot: string,
  ) {
    const existing = state.projectsByRoot.get(workspaceRoot);
    if (existing !== undefined) return { projectId: existing, reused: true } as const;
    const exists = yield* fs.exists(workspaceRoot).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    const base = path.basename(workspaceRoot).trim();
    const fromSession = session.title?.trim();
    const title =
      base.length > 0 ? base : fromSession && fromSession.length > 0 ? fromSession : "project";
    const projectId = ProjectId.make(yield* randomUuidV4);
    const project = yield* projects
      .create({
        commandId: CommandId.make(`claude-import:project-create:${projectId}`),
        projectId,
        title,
        workspaceRoot,
      })
      .pipe(mapFailure(`Failed to create project for ${workspaceRoot}`));
    state.projectsByRoot.set(workspaceRoot, project.id);
    // The service normalizes the root; remember both spellings.
    state.projectsByRoot.set(project.workspaceRoot, project.id);
    return { projectId: project.id, reused: false } as const;
  });

  /**
   * `loadState` snapshots which threads have runs once per sweep, but T3 can
   * start a turn on an import thread while the sweep runs. Re-read right
   * before a write that is only valid for a thread T3 never continued, so the
   * sweep cannot re-import T3's own turn (Claude appends it to the transcript).
   */
  const threadGainedRuns = Effect.fn("ClaudeTranscriptSync.threadGainedRuns")(function* (
    state: SyncState,
    threadId: ThreadId,
  ) {
    if (state.threadsWithRuns.has(threadId)) return true;
    const rows = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(mapFailure("Failed to read the thread's runs"));
    if (rows.length === 0) return false;
    state.threadsWithRuns.add(threadId);
    return true;
  });

  /** Bind an existing import thread that never got its provider thread. */
  const ensureResumable = Effect.fn("ClaudeTranscriptSync.ensureResumable")(function* (
    state: SyncState,
    threadId: ThreadId,
    sessionId: string,
  ) {
    const existing = state.threads.get(threadId);
    // An `activeProviderThreadId` without a provider thread row is a dangling
    // pointer (an import interrupted mid-write by older code): repair it too.
    if (
      existing === undefined ||
      state.threadsWithProviderThreads.has(threadId) ||
      state.threadsWithRuns.has(threadId) ||
      !isClaudeSessionId(sessionId)
    ) {
      return false;
    }
    const thread = decodeStoredAppThread(existing.payloadJson);
    if (thread === undefined || (yield* threadGainedRuns(state, threadId))) return false;
    const suffix = yield* randomUuidV4;
    yield* writeEvents(
      bindExistingThreadToClaudeSession({
        thread,
        sessionId,
        providerInstanceId: thread.providerInstanceId,
        eventIdPrefix: `${IMPORT_EVENT_PREFIX}:rebind:${threadId}:${suffix}`,
      }),
    );
    state.threadsWithProviderThreads.add(threadId);
    return true;
  });

  const syncSession = Effect.fn("ClaudeTranscriptSync.syncSession")(function* (input: {
    readonly state: SyncState;
    readonly session: ParsedClaudeSession;
    readonly instanceId: ProviderInstanceId;
  }) {
    const { state, session, instanceId } = input;
    const workspaceRoot = session.cwd?.trim() ?? "";
    if (workspaceRoot.length === 0) {
      return yield* fail(
        "The transcript has no working directory (cwd); cannot create a project for the import.",
      );
    }
    const sessionId = session.sessionId.trim();
    if (sessionId.length === 0) {
      return yield* fail(
        "The transcript has no session id and none could be derived from the filename.",
      );
    }

    // Owned-session guard: T3 itself produced this session (a native thread,
    // or the forkSession target of an import continued under v1).
    const ownerThreadId = state.ownedSessionIds.get(sessionId);
    if (ownerThreadId !== undefined) {
      return { kind: "skipped-owned", ownerThreadId } satisfies ClaudeSessionOutcome;
    }

    const threadId = ThreadId.make(`${CLAUDE_IMPORT_THREAD_ID_PREFIX}${sessionId}`);
    const existing = state.threads.get(threadId);
    if (
      existing !== undefined &&
      existing.deletedAt === null &&
      state.pendingLegacyTranscripts.has(threadId)
    ) {
      // Migrated from v1 but its messages are still being hydrated in the
      // background; planning against a partial message set would duplicate.
      return { kind: "skipped-pending-migration", threadId } satisfies ClaudeSessionOutcome;
    }
    const plan = planThreadSync({
      session,
      existingThread:
        existing === undefined
          ? null
          : {
              deletedAt: existing.deletedAt,
              hasTurns: state.threadsWithRuns.has(threadId),
              messages: (state.importThreadMessages.get(threadId) ?? []).map((message) => ({
                id: message.id,
                turnId: message.runId,
              })),
            },
      threadStreamEverExisted: state.tombstones.has(threadId),
    });

    switch (plan.kind) {
      case "skip-deleted":
        return { kind: "skipped-deleted", threadId } satisfies ClaudeSessionOutcome;
      case "skip-forked":
        return {
          kind: "skipped-forked",
          threadId,
          reason: plan.reason,
        } satisfies ClaudeSessionOutcome;
      case "unchanged": {
        const rebound = yield* ensureResumable(state, threadId, sessionId);
        return { kind: "unchanged", threadId, rebound } satisfies ClaudeSessionOutcome;
      }
      case "create":
      case "append":
        break;
    }

    if (plan.kind === "create") {
      // Fork-copy guard: a transcript whose messages largely already live on
      // another thread is a forkSession copy of it.
      const copy = detectForkCopy({
        sessionMessages: session.messages,
        threadId,
        messageOwnerIndex: state.messageOwnerIndex,
      });
      if (copy !== null) {
        return {
          kind: "skipped-copy",
          ownerThreadId: copy.ownerThreadId,
          sharedRatio: copy.sharedRatio,
        } satisfies ClaudeSessionOutcome;
      }
    }

    // Message ids are global: never move a message another thread owns.
    const candidates = plan.kind === "create" ? plan.messages : plan.newMessages;
    const toImport = candidates.filter((message) => {
      const owner = state.messageOwnerIndex.get(message.uuid);
      return owner === undefined || owner === threadId;
    });

    const now = yield* DateTime.now;
    const createdAt = utcOr(session.startedAt, now);
    const updatedAt = utcOr(session.endedAt, createdAt);
    const messageEventsFor = (messages: ReadonlyArray<ParsedClaudeMessage>) =>
      messages.flatMap((message) => messageEvents({ threadId, message, fallbackAt: createdAt }));

    if (plan.kind === "append") {
      const continuedInT3 = {
        kind: "skipped-forked",
        threadId,
        reason: "thread has provider turns (it was continued in T3 during this sweep)",
      } satisfies ClaudeSessionOutcome;
      for (const batch of chunks(toImport, MESSAGE_BATCH_SIZE)) {
        if (yield* threadGainedRuns(state, threadId)) return continuedInT3;
        yield* writeEvents(messageEventsFor(batch));
        for (const message of batch) state.messageOwnerIndex.set(message.uuid, threadId);
        yield* Effect.yieldNow;
      }
      const current = decodeStoredAppThread(existing!.payloadJson);
      if (
        toImport.length > 0 &&
        current !== undefined &&
        DateTime.isGreaterThan(updatedAt, current.updatedAt)
      ) {
        // This rewrites the whole thread row from the sweep's snapshot.
        if (yield* threadGainedRuns(state, threadId)) return continuedInT3;
        // Surface the newer activity in the sidebar.
        const suffix = yield* randomUuidV4;
        yield* writeEvents([
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:appended:${suffix}`),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: current.providerInstanceId,
            occurredAt: updatedAt,
            payload: { ...current, updatedAt },
          },
        ]);
      }
      yield* ensureResumable(state, threadId, sessionId);
      return {
        kind: "updated",
        threadId,
        appended: toImport.length,
      } satisfies ClaudeSessionOutcome;
    }

    const project = yield* resolveProject(state, session, workspaceRoot);
    if (project === undefined) {
      return { kind: "skipped-missing-cwd", cwd: workspaceRoot } satisfies ClaudeSessionOutcome;
    }

    const resumable = isClaudeSessionId(sessionId);
    const providerThread = resumable
      ? importedClaudeProviderThread({
          threadId,
          sessionId,
          providerInstanceId: instanceId,
          at: updatedAt,
        })
      : undefined;
    const title = session.title?.trim();
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: project.projectId,
      title: title && title.length > 0 ? title : IMPORTED_THREAD_FALLBACK_TITLE,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: claudeModel },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: session.gitBranch?.trim() || null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThread?.id ?? null,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    const [firstBatch = [], ...restBatches] = chunks(toImport, MESSAGE_BATCH_SIZE);
    // `thread.created` already points at the provider thread, so both go in
    // the same (atomic) write: a failure later in the import must not leave
    // `activeProviderThreadId` dangling.
    yield* writeEvents([
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: createdAt,
        payload: appThread,
      },
      ...(providerThread === undefined
        ? []
        : [
            {
              id: EventId.make(
                `${IMPORT_EVENT_PREFIX}:provider-thread:${threadId}:${providerThread.id}`,
              ),
              type: "provider-thread.updated" as const,
              threadId,
              driver: CLAUDE_DRIVER_KIND,
              providerInstanceId: instanceId,
              occurredAt: updatedAt,
              payload: providerThread,
            },
          ]),
      ...messageEventsFor(firstBatch),
    ]);
    state.threads.set(threadId, {
      payloadJson: "",
      deletedAt: null,
      activeProviderThreadId: providerThread?.id ?? null,
    });
    state.tombstones.add(threadId);
    if (providerThread !== undefined) state.threadsWithProviderThreads.add(threadId);
    for (const message of firstBatch) state.messageOwnerIndex.set(message.uuid, threadId);
    for (const batch of restBatches) {
      yield* Effect.yieldNow;
      yield* writeEvents(messageEventsFor(batch));
      for (const message of batch) state.messageOwnerIndex.set(message.uuid, threadId);
    }

    return {
      kind: "created",
      threadId,
      projectId: project.projectId,
      imported: toImport.length,
      reusedProject: project.reused,
    } satisfies ClaudeSessionOutcome;
  });

  const readTranscript = (filePath: string) =>
    fs.readFileString(filePath).pipe(mapFailure(`Failed to read transcript '${filePath}'`));

  const sessionIdFromFilename = (filePath: string) => {
    const base = path.basename(filePath);
    return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  };

  const projectsRootFor = (options: ClaudeImportOptions) =>
    expandHomePath(options.projectsDir?.trim() || DEFAULT_PROJECTS_DIR);

  const sync: ClaudeTranscriptSyncShape["sync"] = (options) =>
    sweepLock.withPermits(1)(
      Effect.gen(function* () {
        const instanceId = yield* resolveInstanceId(options.instance);
        const projectsRoot = projectsRootFor(options);
        const worktreesDir = config.worktreesDir;
        const worktreesPrefix = worktreesDir.endsWith(path.sep)
          ? worktreesDir
          : `${worktreesDir}${path.sep}`;

        const transcriptPaths: Array<string> = [];
        const projectDirs = yield* fs
          .readDirectory(projectsRoot)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const dir of projectDirs) {
          const dirPath = path.join(projectsRoot, dir);
          const entries = yield* fs
            .readDirectory(dirPath)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          for (const entry of entries) {
            if (entry.endsWith(".jsonl")) transcriptPaths.push(path.join(dirPath, entry));
          }
        }
        transcriptPaths.sort();

        const state = yield* loadState;
        const counters = emptyCounters();
        const lines: Array<string> = [];
        const seenSessionIds = new Set<string>();

        for (const transcriptPath of transcriptPaths) {
          counters.total += 1;
          yield* Effect.yieldNow;
          const fallbackSessionId = sessionIdFromFilename(transcriptPath);

          const info = yield* Effect.result(fs.stat(transcriptPath));
          const fingerprint = Result.isSuccess(info)
            ? `${String(info.success.size)}:${info.success.mtime._tag === "Some" ? info.success.mtime.value.getTime() : 0}`
            : undefined;
          const cached = fileOutcomeCache.get(transcriptPath);
          if (
            cached !== undefined &&
            fingerprint !== undefined &&
            cached.fingerprint === fingerprint &&
            !seenSessionIds.has(cached.sessionId) &&
            cachedOutcomeStillHolds(state, cached)
          ) {
            seenSessionIds.add(cached.sessionId);
            lines.push(recordOutcome(counters, cached.sessionId, cached.outcome));
            continue;
          }

          const content = yield* fs.readFileString(transcriptPath).pipe(Effect.option);
          if (content._tag === "None") {
            counters.failed += 1;
            lines.push(`failed sessionId=${fallbackSessionId} error=unreadable-file`);
            continue;
          }
          const session = parseClaudeTranscript(content.value, {
            sessionIdFromFilename: fallbackSessionId,
          });
          const sessionId = session.sessionId.trim();
          if (
            sessionId.length === 0 ||
            session.messages.length === 0 ||
            session.cwd === null ||
            session.cwd.trim().length === 0
          ) {
            counters.skippedEmpty += 1;
            lines.push(`skipped-empty sessionId=${fallbackSessionId}`);
            continue;
          }
          if (seenSessionIds.has(sessionId)) {
            counters.skippedEmpty += 1;
            lines.push(`skipped-duplicate sessionId=${sessionId} path=${transcriptPath}`);
            continue;
          }
          seenSessionIds.add(sessionId);

          // Sessions inside a T3-managed worktree can only have been spawned by
          // T3 itself (also covers T3 sessions the owned guard cannot see).
          const cwd = session.cwd.trim();
          if (cwd === worktreesDir || cwd.startsWith(worktreesPrefix)) {
            counters.skippedWorktree += 1;
            lines.push(`skipped-worktree sessionId=${sessionId} cwd=${cwd}`);
            continue;
          }
          if (options.includeRalph !== true && isRalphSession(session)) {
            counters.skippedRalph += 1;
            lines.push(`skipped-ralph sessionId=${sessionId}`);
            continue;
          }

          const outcome = yield* Effect.result(syncSession({ state, session, instanceId }));
          if (Result.isFailure(outcome)) {
            counters.failed += 1;
            lines.push(`failed sessionId=${sessionId} error=${outcome.failure.message}`);
            continue;
          }
          lines.push(recordOutcome(counters, sessionId, outcome.success));
          if (fingerprint !== undefined) {
            const settled =
              outcome.success.kind === "created" || outcome.success.kind === "updated"
                ? ({
                    kind: "unchanged",
                    threadId: outcome.success.threadId,
                    rebound: false,
                  } as const)
                : outcome.success;
            if (isStableOutcome(settled)) {
              fileOutcomeCache.set(transcriptPath, { fingerprint, sessionId, outcome: settled });
            } else {
              fileOutcomeCache.delete(transcriptPath);
            }
          }
        }

        return { lines, counters } satisfies ClaudeImportReport;
      }),
    );

  const resolveTranscriptPath = Effect.fn("ClaudeTranscriptSync.resolveTranscriptPath")(function* (
    sessionArg: string,
    options: ClaudeImportOptions,
  ) {
    const trimmed = sessionArg.trim();
    if (trimmed.length === 0) return yield* fail("Session argument cannot be empty.");
    const asPath = expandHomePath(trimmed);
    if (yield* fs.exists(asPath).pipe(Effect.orElseSucceed(() => false))) return asPath;
    const projectsRoot = projectsRootFor(options);
    const projectDirs = yield* fs
      .readDirectory(projectsRoot)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    for (const dir of projectDirs) {
      const candidate = path.join(projectsRoot, dir, `${trimmed}.jsonl`);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
    return yield* fail(
      `Could not find a Claude transcript for '${trimmed}'. Pass a path to a .jsonl file ` +
        `or a session id present under ${projectsRoot}/*/.`,
    );
  });

  const importSession: ClaudeTranscriptSyncShape["importSession"] = (options) =>
    sweepLock.withPermits(1)(
      Effect.gen(function* () {
        const instanceId = yield* resolveInstanceId(options.instance);
        const transcriptPath = yield* resolveTranscriptPath(options.session, options);
        const session = parseClaudeTranscript(yield* readTranscript(transcriptPath), {
          sessionIdFromFilename: sessionIdFromFilename(transcriptPath),
        });
        const state = yield* loadState;
        const counters = emptyCounters();
        counters.total = 1;
        const outcome = yield* syncSession({ state, session, instanceId });
        fileOutcomeCache.delete(transcriptPath);
        const line = recordOutcome(counters, session.sessionId.trim(), outcome);
        return { lines: [line], counters } satisfies ClaudeImportReport;
      }),
    );

  return ClaudeTranscriptSync.of({ sync, importSession });
});

export const layer = Layer.effect(ClaudeTranscriptSync, make);
