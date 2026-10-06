/**
 * Fork: inspect and repair which native Claude session a thread resumes.
 *
 *  - `audit` (`t3 session audit`): read-only. Lists Claude threads whose next
 *    send will `--resume` a session whose transcript is missing on this host
 *    (Claude then fails with "No conversation found with session ID"). Safe
 *    while serving.
 *  - `reset` (`t3 session reset <threadId> --yes`): detaches the thread from
 *    its native session (`activeProviderThreadId: null`), so the next send
 *    starts a fresh Claude session with the thread's history handed off as
 *    context. The old provider thread is kept, so the binding is auditable.
 *  - `restoreLegacyResume` (server startup): v1 → v2 cutover imports every v1
 *    thread with no provider thread, which would drop native resume for every
 *    old Claude thread (incl. `claude-import-*`). This binds each such thread
 *    to the session its v1 `provider_session_runtime` cursor pointed at.
 *    Idempotent; a missing transcript is NOT a reason to skip (the user
 *    restores transcripts and finds the stragglers with `audit`).
 */
import { EventId, type ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { claudeTranscriptRelativePath } from "../provider/claudeSessionTranscript.ts";
import {
  bindExistingThreadToClaudeSession,
  CLAUDE_DRIVER_KIND,
  decodeStoredAppThread,
  isClaudeSessionId,
  readLegacyCursorSessionId,
} from "./claudeResumeEvents.ts";

export class ClaudeResumeBindingError extends Schema.TaggedError<ClaudeResumeBindingError>()(
  "ClaudeResumeBindingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
const mapFailure =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) => new ClaudeResumeBindingError({ detail: `${what}: ${describe(cause)}` }),
    );

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ThreadLifecycle = "active" | "archived" | "deleted" | "unknown";

/**
 * Where a thread's resume target comes from: `v2` = the active provider
 * thread T3 resumes on the next send; `legacy` = a v1 cursor not yet bound
 * (the next server start binds eligible ones).
 */
export type ResumeBindingSource = "v2" | "legacy";

export interface ClaudeResumeTarget {
  readonly threadId: ThreadId;
  readonly title: string | undefined;
  readonly lifecycle: ThreadLifecycle;
  readonly source: ResumeBindingSource;
  readonly sessionId: string;
  readonly cwd: string | undefined;
}

export type TranscriptLocation =
  | { readonly kind: "present"; readonly path: string }
  | { readonly kind: "relocated"; readonly expectedPath: string | undefined; readonly path: string }
  | { readonly kind: "missing"; readonly expectedPath: string | undefined };

export interface SessionAuditRow extends ClaudeResumeTarget {
  readonly location: TranscriptLocation;
}

export function threadLifecycle(
  thread: { readonly archivedAt: unknown; readonly deletedAt: unknown } | undefined,
): ThreadLifecycle {
  if (thread === undefined) return "unknown";
  if (thread.deletedAt !== null && thread.deletedAt !== undefined) return "deleted";
  if (thread.archivedAt !== null && thread.archivedAt !== undefined) return "archived";
  return "active";
}

export function formatAuditRow(row: SessionAuditRow): string {
  const parts = [
    `thread=${row.threadId}`,
    `lifecycle=${row.lifecycle}`,
    `title=${encodeJsonString(row.title ?? "")}`,
    `session=${row.sessionId}`,
    `binding=${row.source}`,
    `cwd=${row.cwd ?? "?"}`,
  ];
  switch (row.location.kind) {
    case "missing":
      parts.push(`expected=${row.location.expectedPath ?? "?"}`);
      break;
    case "relocated":
      parts.push(`expected=${row.location.expectedPath ?? "?"}`, `found=${row.location.path}`);
      break;
    case "present":
      parts.push(`path=${row.location.path}`);
      break;
  }
  return parts.join(" ");
}

/** Every Claude thread with a resume target (v2 bindings + unbound v1 cursors). */
export const listClaudeResumeTargets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectRows = yield* sql<{ readonly project_id: string; readonly workspace_root: string }>`
    SELECT project_id, workspace_root FROM projection_projects
  `;
  const workspaceRoots = new Map(projectRows.map((row) => [row.project_id, row.workspace_root]));

  const threadRows = yield* sql<{
    readonly thread_id: string;
    readonly payload_json: string;
    readonly native_id: string | null;
    readonly strength: string | null;
  }>`
    SELECT
      thread.thread_id,
      thread.payload_json,
      json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
      json_extract(provider.payload_json, '$.nativeThreadRef.strength') AS strength
    FROM orchestration_v2_projection_threads AS thread
    INNER JOIN orchestration_v2_projection_provider_threads AS provider
      ON provider.provider_thread_id = thread.active_provider_thread_id
    WHERE provider.driver = ${CLAUDE_DRIVER_KIND}
    ORDER BY thread.thread_id
  `;
  const legacyRows = yield* sql<{
    readonly thread_id: string;
    readonly resume_cursor_json: string | null;
    readonly runtime_cwd: string | null;
    readonly payload_json: string | null;
  }>`
    SELECT
      runtime.thread_id,
      runtime.resume_cursor_json,
      CASE WHEN json_valid(runtime.runtime_payload_json)
        THEN json_extract(runtime.runtime_payload_json, '$.cwd') END AS runtime_cwd,
      thread.payload_json
    FROM provider_session_runtime AS runtime
    LEFT JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = runtime.thread_id
    WHERE (runtime.provider_name = ${CLAUDE_DRIVER_KIND} OR runtime.adapter_key = ${CLAUDE_DRIVER_KIND})
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider
        WHERE provider.thread_id = runtime.thread_id
      )
    ORDER BY runtime.thread_id
  `;

  const targets: Array<ClaudeResumeTarget> = [];
  for (const row of threadRows) {
    if (row.native_id === null || row.strength !== "strong") continue;
    const thread = decodeStoredAppThread(row.payload_json);
    targets.push({
      threadId: ThreadId.make(row.thread_id),
      title: thread?.title,
      lifecycle: threadLifecycle(thread),
      source: "v2",
      sessionId: row.native_id,
      cwd: thread?.worktreePath ?? (thread ? workspaceRoots.get(thread.projectId) : undefined),
    });
  }
  for (const row of legacyRows) {
    const sessionId = readLegacyCursorSessionId(row.resume_cursor_json);
    if (sessionId === undefined) continue;
    const thread = row.payload_json === null ? undefined : decodeStoredAppThread(row.payload_json);
    targets.push({
      threadId: ThreadId.make(row.thread_id),
      title: thread?.title,
      lifecycle: threadLifecycle(thread),
      source: "legacy",
      sessionId,
      cwd:
        thread?.worktreePath ??
        (thread ? workspaceRoots.get(thread.projectId) : undefined) ??
        row.runtime_cwd ??
        undefined,
    });
  }
  return targets as ReadonlyArray<ClaudeResumeTarget>;
}).pipe(mapFailure("Failed to read Claude resume bindings"));

/**
 * Where Claude Code will look for the transcript. The expected location is
 * derived from the cwd; as a fallback every project folder is searched,
 * because a transcript that moved (cwd renamed) is recoverable in place.
 */
export const locateTranscript = Effect.fn("locateTranscript")(function* (
  projectsRoot: string,
  projectDirs: ReadonlyArray<string>,
  target: Pick<ClaudeResumeTarget, "cwd" | "sessionId">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expectedPath =
    target.cwd !== undefined
      ? path.join(projectsRoot, claudeTranscriptRelativePath(target.cwd, target.sessionId))
      : undefined;
  if (expectedPath !== undefined) {
    if (yield* fs.exists(expectedPath).pipe(Effect.orElseSucceed(() => false))) {
      return { kind: "present", path: expectedPath } satisfies TranscriptLocation;
    }
  }
  const fileName = `${target.sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, fileName);
    if (candidate === expectedPath) continue;
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return { kind: "relocated", expectedPath, path: candidate } satisfies TranscriptLocation;
    }
  }
  return { kind: "missing", expectedPath } satisfies TranscriptLocation;
});

/** Audit rows for every Claude resume target, in lifecycle then id order. */
export const auditClaudeResumeTargets = Effect.fn("auditClaudeResumeTargets")(function* (input: {
  readonly projectsRoot: string;
  readonly includeDeleted: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const projectDirs = yield* fs
    .readDirectory(input.projectsRoot)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const targets = yield* listClaudeResumeTargets;
  const rows: Array<SessionAuditRow> = [];
  for (const target of targets) {
    if (target.lifecycle === "deleted" && !input.includeDeleted) continue;
    const location = yield* locateTranscript(input.projectsRoot, projectDirs, target);
    rows.push({ ...target, location });
  }
  const lifecycleOrder: Record<ThreadLifecycle, number> = {
    active: 0,
    archived: 1,
    unknown: 2,
    deleted: 3,
  };
  return rows.sort(
    (a, b) =>
      lifecycleOrder[a.lifecycle] - lifecycleOrder[b.lifecycle] ||
      a.threadId.localeCompare(b.threadId),
  ) as ReadonlyArray<SessionAuditRow>;
});

// ---------------------------------------------------------------------------
// Reset + legacy restore (write through the event sink)
// ---------------------------------------------------------------------------

export interface ClaudeSessionResetResult {
  readonly lines: ReadonlyArray<string>;
  readonly reset: boolean;
}

export interface LegacyResumeRestoreSummary {
  readonly restored: number;
  readonly skipped: number;
}

export interface ClaudeResumeBindingsShape {
  readonly reset: (input: {
    readonly threadId: ThreadId;
    readonly apply: boolean;
  }) => Effect.Effect<ClaudeSessionResetResult, ClaudeResumeBindingError>;
  /** Startup step; never fails (per-thread problems are logged and skipped). */
  readonly restoreLegacyResume: Effect.Effect<LegacyResumeRestoreSummary>;
}

export class ClaudeResumeBindings extends Context.Service<
  ClaudeResumeBindings,
  ClaudeResumeBindingsShape
>()("t3/import/ClaudeResumeBindings") {}

const BLOCKING_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;

  const reset: ClaudeResumeBindingsShape["reset"] = ({ threadId, apply }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly payload_json: string;
        readonly provider_thread_id: string | null;
        readonly driver: string | null;
        readonly native_id: string | null;
      }>`
        SELECT
          thread.payload_json,
          provider.provider_thread_id,
          provider.driver,
          json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') AS native_id
        FROM orchestration_v2_projection_threads AS thread
        LEFT JOIN orchestration_v2_projection_provider_threads AS provider
          ON provider.provider_thread_id = thread.active_provider_thread_id
        WHERE thread.thread_id = ${threadId}
        LIMIT 1
      `.pipe(mapFailure("Failed to read the thread"));
      const row = rows[0];
      const thread = row === undefined ? undefined : decodeStoredAppThread(row.payload_json);
      if (row === undefined || thread === undefined) {
        return yield* new ClaudeResumeBindingError({ detail: `Thread ${threadId} was not found.` });
      }
      if (thread.activeProviderThreadId === null) {
        return {
          lines: [
            `Thread ${threadId} is not bound to a provider session; its next message already starts a fresh session.`,
          ],
          reset: false,
        };
      }
      const statuses = BLOCKING_RUN_STATUSES as ReadonlyArray<string>;
      const busy = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ${sql.in(statuses)}
      `.pipe(mapFailure("Failed to read the thread's runs"));
      const lines = [
        `Thread ${threadId} (${row.driver ?? "unknown driver"}, instance ${thread.providerInstanceId})`,
        `  provider thread: ${thread.activeProviderThreadId}`,
        `  native session:  ${row.native_id ?? "(none yet)"}`,
        "  keep these lines if you may want to restore the binding by hand later.",
      ];
      if ((busy[0]?.count ?? 0) > 0) {
        return yield* new ClaudeResumeBindingError({
          detail: `${lines.join("\n")}\nThread ${threadId} has a run in progress or queued; stop it before resetting.`,
        });
      }
      // Any later `provider-thread.updated` for the old provider thread points
      // the app thread back at it, silently undoing the reset. Those come from
      // a loaded provider session (live adapter events) and from startup
      // recovery of provider threads still marked active or waiting on
      // background tasks — so refuse while either could still happen.
      const liveSessions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_provider_sessions AS session
        WHERE session.status NOT IN ('stopped', 'error')
          AND (
            session.thread_id = ${threadId}
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
              WHERE binding.provider_session_id = session.provider_session_id
                AND binding.thread_id = ${threadId}
            )
          )
      `.pipe(mapFailure("Failed to read the thread's provider sessions"));
      const unsettledProviderThreads = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_provider_threads
        WHERE thread_id = ${threadId}
          AND (
            status = 'active'
            OR COALESCE(json_array_length(payload_json, '$.pendingBackgroundTasks'), 0) > 0
          )
      `.pipe(mapFailure("Failed to read the thread's provider threads"));
      if ((liveSessions[0]?.count ?? 0) > 0 || (unsettledProviderThreads[0]?.count ?? 0) > 0) {
        return yield* new ClaudeResumeBindingError({
          detail:
            `${lines.join("\n")}\nThread ${threadId} still has a loaded provider session or ` +
            "unfinished background work, which would re-attach the old session after a reset. " +
            "Stop the thread and retry once its provider session has closed (idle sessions close " +
            "on their own after a period of inactivity, or restart the server).",
        });
      }
      if (!apply) {
        return {
          lines: [
            ...lines,
            "Dry run: no changes made. Re-run with --yes to reset. If the transcript can still be " +
              "recovered from another machine, restore it instead of resetting.",
          ],
          reset: false,
        };
      }
      const suffix = yield* randomUuidV4;
      yield* eventSink
        .write({
          events: [
            {
              id: EventId.make(`fork:session-reset:${threadId}:${suffix}`),
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: thread.updatedAt,
              payload: { ...thread, activeProviderThreadId: null },
            },
          ],
        })
        .pipe(mapFailure("Failed to reset the thread"));
      return {
        lines: [
          ...lines,
          `Reset thread ${threadId}: its next message starts a fresh ${row.driver ?? "provider"} session ` +
            "with the thread's T3 history handed over as context (the provider-side history itself is not resumed).",
        ],
        reset: true,
      };
    });

  const restoreLegacyResume: ClaudeResumeBindingsShape["restoreLegacyResume"] = Effect.gen(
    function* () {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly payload_json: string;
        readonly provider_instance_id: string | null;
        readonly resume_cursor_json: string | null;
      }>`
        SELECT
          thread.thread_id,
          thread.payload_json,
          runtime.provider_instance_id,
          runtime.resume_cursor_json
        FROM orchestration_v2_projection_threads AS thread
        INNER JOIN provider_session_runtime AS runtime
          ON runtime.thread_id = thread.thread_id
        WHERE thread.deleted_at IS NULL
          AND thread.active_provider_thread_id IS NULL
          AND json_extract(thread.payload_json, '$.historyOrigin') = 'v1_import'
          AND (runtime.provider_name = ${CLAUDE_DRIVER_KIND} OR runtime.adapter_key = ${CLAUDE_DRIVER_KIND})
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider
            WHERE provider.thread_id = thread.thread_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id = thread.thread_id
          )
        ORDER BY thread.thread_id
      `;
      let restored = 0;
      let skipped = 0;
      for (const row of rows) {
        const thread = decodeStoredAppThread(row.payload_json);
        const sessionId = readLegacyCursorSessionId(row.resume_cursor_json);
        const instanceId = (row.provider_instance_id ?? thread?.modelSelection.instanceId) as
          | ProviderInstanceId
          | undefined;
        // Only bind when the thread still targets the instance that owns the
        // session; a thread switched to another provider keeps the handoff path.
        if (
          thread === undefined ||
          sessionId === undefined ||
          !isClaudeSessionId(sessionId) ||
          instanceId === undefined ||
          instanceId !== thread.providerInstanceId
        ) {
          skipped += 1;
          continue;
        }
        const suffix = yield* randomUuidV4;
        const wrote = yield* eventSink
          .write({
            events: bindExistingThreadToClaudeSession({
              thread,
              sessionId,
              providerInstanceId: instanceId,
              eventIdPrefix: `fork:legacy-claude-resume:${thread.id}:${suffix}`,
            }),
          })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("Could not restore Claude resume for a migrated v1 thread", {
                threadId: thread.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
        if (wrote) restored += 1;
        else skipped += 1;
        yield* Effect.yieldNow;
      }
      return { restored, skipped } satisfies LegacyResumeRestoreSummary;
    },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Restoring Claude resume for migrated v1 threads failed", { cause }).pipe(
        Effect.as({ restored: 0, skipped: 0 } satisfies LegacyResumeRestoreSummary),
      ),
    ),
  );

  return ClaudeResumeBindings.of({ reset, restoreLegacyResume });
});

export const layer = Layer.effect(ClaudeResumeBindings, make);
