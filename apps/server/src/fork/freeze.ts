/**
 * Fork: `t3 freeze` / `t3 thaw` — silence every conversation on this server so a measured task is
 * the only thing drawing on the Claude subscription. Stopping a thread is the user's Stop button:
 * the turn is interrupted, background agents/commands end with it, and its queue is held. Freeze
 * also disables scheduled tasks, which would otherwise launch fresh runs mid-measurement.
 *
 * "Busy" is read straight from the projection tables, the same way the redeploy idle gate does
 * (`scripts/deploy-idle-check.ts`), plus background work that outlives a turn.
 */
import { CommandId, NodeId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";

export interface BusyThread {
  readonly threadId: string;
  readonly title: string;
  /** Why the thread counts as busy: `run:<status>`, `subagent`, `workflow`, or `background`. */
  readonly reasons: ReadonlyArray<string>;
}

export interface FreezeFilter {
  /** Threads that are never touched, e.g. the chat running the measured task. */
  readonly keepThreads: ReadonlyArray<string>;
  /** Threads whose git worktree is one of these paths are never touched. */
  readonly keepWorktrees: ReadonlyArray<string>;
}

interface BusyRow {
  readonly threadId: string;
  readonly reason: string;
  readonly subagentId: string | null;
  readonly title: string | null;
  readonly payload: string | null;
}

export interface FreezeResult {
  readonly stopped: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  readonly scheduledTasksDisabled: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Still working when the wait ran out. Empty means the server is quiet. */
  readonly remaining: ReadonlyArray<BusyThread>;
  /** Stop requests and task updates that failed; informational. */
  readonly errors: ReadonlyArray<string>;
}

function worktreePathOf(payload: string | null): string | null {
  if (payload === null) return null;
  try {
    const path = (JSON.parse(payload) as { worktreePath?: unknown } | null)?.worktreePath;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

/** One entry per thread, minus the kept ones. */
export function toBusyThreads(rows: ReadonlyArray<BusyRow>, filter: FreezeFilter): BusyThread[] {
  const keepThreads = new Set(filter.keepThreads);
  const keepWorktrees = new Set(filter.keepWorktrees);
  const byThread = new Map<string, { title: string; reasons: Set<string> }>();
  for (const row of rows) {
    if (keepThreads.has(row.threadId)) continue;
    const worktree = worktreePathOf(row.payload);
    if (worktree !== null && keepWorktrees.has(worktree)) continue;
    const entry = byThread.get(row.threadId) ?? { title: row.title ?? "", reasons: new Set() };
    entry.reasons.add(row.reason);
    byThread.set(row.threadId, entry);
  }
  return [...byThread].map(([threadId, { title, reasons }]) => ({
    threadId,
    title,
    reasons: [...reasons],
  }));
}

const BUSY_SQL_ROWS = (sql: SqlClient.SqlClient) => sql<BusyRow>`
  SELECT b.threadId AS threadId, b.reason AS reason, b.subagentId AS subagentId,
         t.title AS title, t.payload_json AS payload
  FROM (
    SELECT r.thread_id AS threadId, 'run:' || r.status AS reason, NULL AS subagentId
    FROM orchestration_v2_projection_runs r
    WHERE r.status IN ('preparing', 'starting', 'running')
       OR (r.status = 'queued'
           AND COALESCE(json_extract(r.payload_json, '$.queueHeld'), 0) != 1)
    UNION ALL
    SELECT s.thread_id,
           CASE WHEN json_extract(s.payload_json, '$.workflow') IS NOT NULL
                THEN 'workflow' ELSE 'subagent' END,
           s.subagent_id
    FROM orchestration_v2_projection_subagents s
    WHERE s.status = 'running'
    UNION ALL
    SELECT p.thread_id, 'background', NULL
    FROM orchestration_v2_projection_provider_threads p
    WHERE p.thread_id IS NOT NULL
      AND CASE WHEN json_valid(p.payload_json)
               THEN json_array_length(p.payload_json, '$.pendingBackgroundTasks') > 0
               ELSE 0 END
  ) b
  JOIN orchestration_v2_projection_threads t ON t.thread_id = b.threadId
  WHERE t.deleted_at IS NULL`;

const readBusy = (filter: FreezeFilter) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* BUSY_SQL_ROWS(sql);
    return { rows, busy: toBusyThreads(rows, filter) };
  });

/** Threads working right now, minus the kept ones. */
export const findBusyThreads = (filter: FreezeFilter) =>
  readBusy(filter).pipe(Effect.map(({ busy }) => busy));

const describeError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);

export interface FreezePace {
  readonly poll: Duration.Duration;
  /** A run can end by itself and start a queued follow-up a beat later, so quiet has to hold. */
  readonly quietConfirm: Duration.Duration;
}

const DEFAULT_PACE: FreezePace = {
  poll: Duration.seconds(2),
  quietConfirm: Duration.seconds(3),
};

/**
 * Disable scheduled tasks, then stop every busy thread until the server stays quiet or `waitSecs`
 * runs out. Safe to call again: stopping an idle thread is a no-op and tasks already disabled are
 * not reported.
 */
export const freezeThreads = (input: {
  readonly freezeId: string;
  readonly filter: FreezeFilter;
  readonly waitSecs: number;
  readonly reason: string;
  readonly pace?: FreezePace;
}) =>
  Effect.gen(function* () {
    const pace = input.pace ?? DEFAULT_PACE;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const errors: string[] = [];

    const disabled: Array<{ id: string; title: string }> = [];
    const listed = yield* scheduledTasks.list().pipe(
      Effect.catch((error) => {
        errors.push(`could not list scheduled tasks: ${describeError(error)}`);
        return Effect.succeed({ tasks: [] });
      }),
    );
    for (const task of listed.tasks) {
      if (!task.enabled) continue;
      yield* scheduledTasks.setEnabled({ id: task.id, enabled: false }).pipe(
        Effect.map(() => {
          disabled.push({ id: task.id, title: task.title });
        }),
        Effect.catch((error) => {
          errors.push(`could not disable scheduled task ${task.id}: ${describeError(error)}`);
          return Effect.void;
        }),
      );
    }

    const stopped = new Map<string, string>();
    const deadline = (yield* Clock.currentTimeMillis) + input.waitSecs * 1000;
    let round = 0;
    let quietPolls = 0;
    let latest: ReadonlyArray<BusyThread> = [];
    while (true) {
      const { rows, busy } = yield* readBusy(input.filter);
      latest = busy;
      if (busy.length === 0) {
        quietPolls += 1;
        if (quietPolls >= 2) break;
        yield* Effect.sleep(pace.quietConfirm);
        continue;
      }
      quietPolls = 0;
      // The first round always runs, so a wait of 0 still stops everything once.
      if (round > 0 && (yield* Clock.currentTimeMillis) >= deadline) break;
      round += 1;
      for (const thread of busy) {
        stopped.set(thread.threadId, thread.title);
        const threadId = ThreadId.make(thread.threadId);
        const commandId = CommandId.make(
          `command:freeze:${input.freezeId}:${round}:${thread.threadId}`,
        );
        yield* threads
          .dispatch({ type: "thread.stop", commandId, threadId, reason: input.reason })
          .pipe(
            Effect.andThen(
              threads.stopDelegatedTasks({ threadId, commandId, reason: input.reason }),
            ),
            Effect.catch((error) => {
              errors.push(`could not stop ${thread.threadId}: ${describeError(error)}`);
              return Effect.void;
            }),
          );
      }
      // A workflow outlives a plain interrupt on some providers; ask for it by name from the
      // second round on, once the cheap path has had its chance.
      if (round >= 2) {
        const busyIds = new Set(busy.map((thread) => thread.threadId));
        for (const row of rows) {
          if (row.reason !== "workflow" || row.subagentId === null) continue;
          if (!busyIds.has(row.threadId)) continue;
          yield* threads
            .stopWorkflow({
              threadId: ThreadId.make(row.threadId),
              subagentId: NodeId.make(row.subagentId),
            })
            .pipe(Effect.ignore);
        }
      }
      yield* Effect.sleep(pace.poll);
    }

    return {
      stopped: [...stopped].map(([threadId, title]) => ({ threadId, title })),
      scheduledTasksDisabled: disabled,
      remaining: latest,
      errors,
    } satisfies FreezeResult;
  });

/** Re-enable the scheduled tasks `freezeThreads` disabled. Returns the ids that came back. */
export const enableScheduledTasks = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const results: Array<{ id: string; enabled: boolean; detail: string }> = [];
    for (const id of ids) {
      yield* scheduledTasks.setEnabled({ id: ScheduledTaskId.make(id), enabled: true }).pipe(
        Effect.map(() => {
          results.push({ id, enabled: true, detail: "enabled" });
        }),
        Effect.catch((error) => {
          results.push({ id, enabled: false, detail: describeError(error) });
          return Effect.void;
        }),
      );
    }
    return results;
  });
