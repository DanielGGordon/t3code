import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { enableScheduledTasks, findBusyThreads, freezeThreads, toBusyThreads } from "./freeze.ts";

const NOW = "2026-10-21T00:00:00.000Z";
const FAST = { poll: Duration.millis(1), quietConfirm: Duration.millis(1) };

const insertThread = (sql: SqlClient.SqlClient, id: string, worktreePath?: string) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${id}, 'project-1', ${`title ${id}`}, 'claudeAgent', 'full-access', 'default',
      ${NOW}, ${NOW}, ${JSON.stringify({ worktreePath: worktreePath ?? null })}
    )`;

const insertRun = (sql: SqlClient.SqlClient, threadId: string, status: string, held = false) =>
  sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, status, requested_at, payload_json
    ) VALUES (
      ${`run:${threadId}:${status}:${held}`}, ${threadId}, ${held ? 2 : 1}, 'claudeAgent',
      ${status}, ${NOW}, ${JSON.stringify({ queueHeld: held })}
    )`;

const insertSubagent = (
  sql: SqlClient.SqlClient,
  threadId: string,
  id: string,
  workflow: boolean,
) =>
  sql`
    INSERT INTO orchestration_v2_projection_subagents (
      subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json
    ) VALUES (
      ${id}, ${threadId}, 'node', 'claudeAgent', 'provider_native', 'running', ${NOW},
      ${JSON.stringify(workflow ? { workflow: { name: "w" } } : {})}
    )`;

const stopThread = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`;
  });

it("keeps listed threads and worktrees out and merges a thread's reasons", () => {
  const row = (threadId: string, reason: string, payload: string | null = null) => ({
    threadId,
    reason,
    subagentId: null,
    title: threadId,
    payload,
  });
  const busy = toBusyThreads(
    [
      row("a", "run:running"),
      row("a", "subagent"),
      row("mine", "run:running"),
      row("wt", "run:running", JSON.stringify({ worktreePath: "/work/mine" })),
      row("other", "background", JSON.stringify({ worktreePath: "/work/other" })),
    ],
    { keepThreads: ["mine"], keepWorktrees: ["/work/mine"] },
  );
  expect(busy).toEqual([
    { threadId: "a", title: "a", reasons: ["run:running", "subagent"] },
    { threadId: "other", title: "other", reasons: ["background"] },
  ]);
});

const withDb = Effect.provide(SqlitePersistence.layerMemory);

it.live("stops working threads and scheduled tasks, but not the kept chat or idle ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const id of ["running", "workflow", "queued", "held", "done", "mine"]) {
      yield* insertThread(sql, id);
    }
    yield* insertRun(sql, "running", "running");
    yield* insertRun(sql, "workflow", "running");
    yield* insertSubagent(sql, "workflow", "agent-1", true);
    yield* insertRun(sql, "queued", "queued");
    yield* insertRun(sql, "held", "queued", true);
    yield* insertRun(sql, "done", "completed");
    yield* insertRun(sql, "mine", "running");

    const enabledTasks = new Map([
      ["task-on", true],
      ["task-off", false],
    ]);
    const stops: string[] = [];
    const threads = {
      dispatch: (command: { type: string; threadId: string }) =>
        stopThread(sql, command.threadId).pipe(
          Effect.map(() => {
            stops.push(`${command.type}:${command.threadId}`);
            return {};
          }),
        ),
      stopDelegatedTasks: () => Effect.void,
      stopWorkflow: () => Effect.void,
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const scheduledTasks = {
      list: () =>
        Effect.succeed({
          tasks: [...enabledTasks].map(([id, enabled]) => ({ id, title: `Task ${id}`, enabled })),
        }),
      setEnabled: (input: { id: string; enabled: boolean }) =>
        Effect.sync(() => {
          enabledTasks.set(input.id, input.enabled);
          return {};
        }),
    } as unknown as ScheduledTaskService.ScheduledTaskService["Service"];

    const result = yield* freezeThreads({
      freezeId: "f1",
      filter: { keepThreads: ["mine"], keepWorktrees: [] },
      waitSecs: 5,
      reason: "test",
      pace: FAST,
    }).pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ScheduledTaskService.ScheduledTaskService, scheduledTasks),
    );

    expect(result.stopped.map((thread) => thread.threadId).toSorted()).toEqual([
      "queued",
      "running",
      "workflow",
    ]);
    expect(stops.toSorted()).toEqual([
      "thread.stop:queued",
      "thread.stop:running",
      "thread.stop:workflow",
    ]);
    expect(result.scheduledTasksDisabled).toEqual([{ id: "task-on", title: "Task task-on" }]);
    expect(enabledTasks.get("task-on")).toBe(false);
    expect(result.remaining).toEqual([]);
    // The measured chat is still the only thing working.
    const stillBusy = yield* findBusyThreads({ keepThreads: [], keepWorktrees: [] });
    expect(stillBusy.map((thread) => thread.threadId)).toEqual(["mine"]);
  }).pipe(withDb),
);

it.live("reports a thread that ignores the stop instead of claiming quiet", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "stubborn");
    yield* insertRun(sql, "stubborn", "running");
    const threads = {
      dispatch: () => Effect.succeed({}),
      stopDelegatedTasks: () => Effect.void,
      stopWorkflow: () => Effect.void,
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const scheduledTasks = {
      list: () => Effect.succeed({ tasks: [] }),
    } as unknown as ScheduledTaskService.ScheduledTaskService["Service"];

    const result = yield* freezeThreads({
      freezeId: "f2",
      filter: { keepThreads: [], keepWorktrees: [] },
      waitSecs: 0,
      reason: "test",
      pace: FAST,
    }).pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ScheduledTaskService.ScheduledTaskService, scheduledTasks),
    );

    expect(result.stopped.map((thread) => thread.threadId)).toEqual(["stubborn"]);
    expect(result.remaining.map((thread) => thread.threadId)).toEqual(["stubborn"]);
  }).pipe(withDb),
);

it.effect("re-enables tasks and reports the ones that fail", () =>
  Effect.gen(function* () {
    const scheduledTasks = {
      setEnabled: (input: { id: string }) =>
        input.id === "gone" ? Effect.fail({ message: "no such task" }) : Effect.succeed({}),
    } as unknown as ScheduledTaskService.ScheduledTaskService["Service"];
    const results = yield* enableScheduledTasks(["ok", "gone"]).pipe(
      Effect.provideService(ScheduledTaskService.ScheduledTaskService, scheduledTasks),
    );
    expect(results).toEqual([
      { id: "ok", enabled: true, detail: "enabled" },
      { id: "gone", enabled: false, detail: "no such task" },
    ]);
  }),
);
