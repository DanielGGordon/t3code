import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import {
  FORK_CLAUDE_IMPORT_ROUTE_PATH,
  FORK_FREEZE_ROUTE_PATH,
  FORK_THAW_ROUTE_PATH,
  FORK_NOTICE_ROUTE_PATH,
  FORK_NUDGE_ROUTE_PATH,
  FORK_SESSION_RESET_ROUTE_PATH,
  forkRouteLayer,
} from "./http.ts";

const OPERATE_TOKEN = "operate-token";
const READ_ONLY_TOKEN = "read-only-token";

const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
  (request) => {
    const authorization = request.headers["authorization"] ?? "";
    const scopes =
      authorization === `Bearer ${OPERATE_TOKEN}`
        ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
        : authorization === `Bearer ${READ_ONLY_TOKEN}`
          ? [AuthOrchestrationReadScope]
          : null;
    return scopes === null
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-fork-test"),
          subject: "fork-test",
          method: "bearer-access-token" as const,
          scopes,
        });
  };
const auth = { authenticateHttpRequest } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const post = (path: string, body: unknown, token?: string) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

function run(request: Request, calls: Array<unknown>) {
  const sync = ClaudeTranscriptSync.ClaudeTranscriptSync.of({
    sync: (options) =>
      Effect.sync(() => {
        calls.push({ sync: options });
        const counters = ClaudeTranscriptSync.emptyCounters();
        counters.created = 1;
        counters.total = 1;
        return { lines: ["created sessionId=s messages=2"], counters };
      }),
    importSession: (options) =>
      Effect.sync(() => {
        calls.push({ importSession: options });
        return { lines: ["created"], counters: ClaudeTranscriptSync.emptyCounters() };
      }),
  });
  const bindings = ClaudeResumeBindings.ClaudeResumeBindings.of({
    reset: (input) =>
      input.threadId === "busy"
        ? Effect.fail(
            new ClaudeResumeBindings.ClaudeResumeBindingError({ detail: "run in progress" }),
          )
        : Effect.sync(() => {
            calls.push({ reset: input });
            return { lines: ["reset"], reset: input.apply };
          }),
    restoreLegacyResume: Effect.succeed({ restored: 0, skipped: 0 }),
  });
  const lifecycleEvents = ServerLifecycleEvents.ServerLifecycleEvents.of({
    publish: (event) =>
      Effect.sync(() => {
        calls.push({ publish: event });
        return { ...event, sequence: 1 };
      }),
    snapshot: Effect.succeed({ sequence: 0, events: [] }),
    stream: Stream.empty,
  });
  const threads = {
    getThreadRecords: (threadId: string) =>
      threadId === "gone"
        ? Effect.fail({ message: "Thread gone does not exist." })
        : Effect.succeed({}),
    dispatch: (command: unknown) =>
      Effect.sync(() => {
        calls.push({ dispatch: command });
        return {};
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const scheduledTasks = {
    setEnabled: (input: { id: string; enabled: boolean }) =>
      input.id === "gone"
        ? Effect.fail({ message: "no such task" })
        : Effect.sync(() => {
            calls.push({ setEnabled: input });
            return {};
          }),
  } as unknown as ScheduledTaskService.ScheduledTaskService["Service"];
  // Nothing is busy: the freeze route only needs a query that returns no rows here.
  const sql = (() => Effect.succeed([])) as unknown as SqlClient.SqlClient;
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(forkRouteLayer.pipe(Layer.provide(NodeServices.layer)), {
        disableLogger: true,
      }),
    ),
    ({ handler }) =>
      Effect.promise(() =>
        handler(
          request,
          Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
            Context.add(ClaudeTranscriptSync.ClaudeTranscriptSync, sync),
            Context.add(ClaudeResumeBindings.ClaudeResumeBindings, bindings),
            Context.add(ServerLifecycleEvents.ServerLifecycleEvents, lifecycleEvents),
            Context.add(ThreadManagementService.ThreadManagementService, threads),
            Context.add(ScheduledTaskService.ScheduledTaskService, scheduledTasks),
            Context.add(SqlClient.SqlClient, sql),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(() => dispose()),
  );
}

it.effect("runs the Claude import sweep for operate-scoped sessions", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const response = yield* run(
      post(FORK_CLAUDE_IMPORT_ROUTE_PATH, { includeRalph: true, projectsDir: "/p" }, OPERATE_TOKEN),
      calls,
    );
    expect(response.status).toBe(200);
    const body = (yield* Effect.promise(() => response.json())) as { summary: string };
    expect(body.summary).toContain("created=1");
    expect(calls).toEqual([{ sync: { includeRalph: true, projectsDir: "/p" } }]);

    const single = yield* run(
      post(FORK_CLAUDE_IMPORT_ROUTE_PATH, { session: "abc" }, OPERATE_TOKEN),
      calls,
    );
    expect(single.status).toBe(200);
    expect(calls.at(-1)).toEqual({ importSession: { session: "abc" } });
  }),
);

it.effect("requires an operate-scoped session", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    expect((yield* run(post(FORK_CLAUDE_IMPORT_ROUTE_PATH, {}), calls)).status).toBe(401);
    expect(
      (yield* run(
        post(FORK_SESSION_RESET_ROUTE_PATH, { threadId: "t", apply: true }, READ_ONLY_TOKEN),
        calls,
      )).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  }),
);

it.effect("resets a thread and maps refusals to 409", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const ok = yield* run(
      post(FORK_SESSION_RESET_ROUTE_PATH, { threadId: "thread-1", apply: true }, OPERATE_TOKEN),
      calls,
    );
    expect(ok.status).toBe(200);
    expect(yield* Effect.promise(() => ok.json())).toEqual({ lines: ["reset"], reset: true });
    const busy = yield* run(
      post(FORK_SESSION_RESET_ROUTE_PATH, { threadId: "busy", apply: true }, OPERATE_TOKEN),
      calls,
    );
    expect(busy.status).toBe(409);
    expect(yield* Effect.promise(() => busy.json())).toEqual({ error: "run in progress" });
    const invalid = yield* run(
      post(FORK_SESSION_RESET_ROUTE_PATH, { apply: true }, OPERATE_TOKEN),
      calls,
    );
    expect(invalid.status).toBe(400);
  }),
);

it.effect("publishes a trimmed notice on the lifecycle stream and rejects blank ones", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const ok = yield* run(
      post(FORK_NOTICE_ROUTE_PATH, { message: "  Restarting to deploy  " }, OPERATE_TOKEN),
      calls,
    );
    expect(ok.status).toBe(200);
    const { id } = (yield* Effect.promise(() => ok.json())) as { id: string };
    expect(id).toMatch(/^\d+$/);
    expect(calls).toEqual([
      { publish: { version: 1, type: "notice", payload: { id, message: "Restarting to deploy" } } },
    ]);

    const blank = yield* run(
      post(FORK_NOTICE_ROUTE_PATH, { message: "   " }, OPERATE_TOKEN),
      calls,
    );
    expect(blank.status).toBe(400);
    const unauthorized = yield* run(
      post(FORK_NOTICE_ROUTE_PATH, { message: "x" }, READ_ONLY_TOKEN),
      calls,
    );
    expect(unauthorized.status).toBe(403);
    expect(calls).toHaveLength(1);
  }),
);

it.effect("queues the nudge as a system notification and reports threads that cannot take it", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const ok = yield* run(
      post(
        FORK_NUDGE_ROUTE_PATH,
        { threadIds: ["thread-1", "gone"], message: "  Please continue.  ", nudgeId: "n1" },
        OPERATE_TOKEN,
      ),
      calls,
    );
    expect(ok.status).toBe(200);
    expect(yield* Effect.promise(() => ok.json())).toEqual({
      results: [
        { threadId: "thread-1", sent: true, detail: "queued" },
        { threadId: "gone", sent: false, detail: "Thread gone does not exist." },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      dispatch: {
        type: "message.dispatch",
        commandId: "command:nudge:n1:thread-1",
        messageId: "message:nudge:n1:thread-1",
        threadId: "thread-1",
        text: "Please continue.",
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        notification: { source: { kind: "system" }, detail: "Please continue." },
      },
    });

    const blank = yield* run(
      post(FORK_NUDGE_ROUTE_PATH, { threadIds: ["t"], message: " ", nudgeId: "n" }, OPERATE_TOKEN),
      calls,
    );
    expect(blank.status).toBe(400);
    const unauthorized = yield* run(
      post(
        FORK_NUDGE_ROUTE_PATH,
        { threadIds: ["t"], message: "x", nudgeId: "n" },
        READ_ONLY_TOKEN,
      ),
      calls,
    );
    expect(unauthorized.status).toBe(403);
    expect(calls).toHaveLength(1);
  }),
);

it.effect("reports what is busy on freeze check and rejects malformed requests", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const ok = yield* run(
      post(
        FORK_FREEZE_ROUTE_PATH,
        { action: "check", freezeId: "f", keepThreads: ["t"], keepWorktrees: [], waitSecs: 0 },
        OPERATE_TOKEN,
      ),
      calls,
    );
    expect(ok.status).toBe(200);
    expect(yield* Effect.promise(() => ok.json())).toEqual({
      stopped: [],
      scheduledTasksDisabled: [],
      remaining: [],
      errors: [],
    });
    const invalid = yield* run(
      post(FORK_FREEZE_ROUTE_PATH, { action: "explode", freezeId: "f" }, OPERATE_TOKEN),
      calls,
    );
    expect(invalid.status).toBe(400);
    const unauthorized = yield* run(
      post(
        FORK_FREEZE_ROUTE_PATH,
        { action: "check", freezeId: "f", keepThreads: [], keepWorktrees: [], waitSecs: 0 },
        READ_ONLY_TOKEN,
      ),
      calls,
    );
    expect(unauthorized.status).toBe(403);
    expect(calls).toEqual([]);
  }),
);

it.effect("thaw re-enables tasks, nudges stopped threads, and skips the nudge when blank", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const ok = yield* run(
      post(
        FORK_THAW_ROUTE_PATH,
        {
          scheduledTaskIds: ["task-1", "gone"],
          threadIds: ["thread-1"],
          message: "Please continue.",
          nudgeId: "thaw-1",
        },
        OPERATE_TOKEN,
      ),
      calls,
    );
    expect(ok.status).toBe(200);
    expect(yield* Effect.promise(() => ok.json())).toEqual({
      scheduledTasks: [
        { id: "task-1", enabled: true, detail: "enabled" },
        { id: "gone", enabled: false, detail: "no such task" },
      ],
      nudges: [{ threadId: "thread-1", sent: true, detail: "queued" }],
    });
    expect(calls[0]).toEqual({ setEnabled: { id: "task-1", enabled: true } });
    expect(calls[1]).toMatchObject({ dispatch: { threadId: "thread-1" } });

    const silent = yield* run(
      post(
        FORK_THAW_ROUTE_PATH,
        { scheduledTaskIds: [], threadIds: ["thread-1"], message: "", nudgeId: "thaw-2" },
        OPERATE_TOKEN,
      ),
      calls,
    );
    expect(yield* Effect.promise(() => silent.json())).toEqual({ scheduledTasks: [], nudges: [] });
    expect(calls).toHaveLength(2);
  }),
);
