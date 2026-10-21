/**
 * Fork-only raw HTTP routes used by the `t3` CLI while a server is running.
 *
 * `t3 import sync|claude` and `t3 session reset` write v2 orchestration
 * events. Doing that from a second process would bypass the server's live
 * event publication (clients would not see the change until a reload) and
 * race its writers, so when a server is up the CLI asks it to do the work
 * here; the CLI only runs the same services in-process when no server runs.
 *
 * Auth: an operate-scoped session, like the other raw routes.
 */
import { AuthOrchestrationOperateScope, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Freeze from "./freeze.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";

export const FORK_CLAUDE_IMPORT_ROUTE_PATH = "/api/fork/import/claude-sync";
export const FORK_SESSION_RESET_ROUTE_PATH = "/api/fork/session/reset";
export const FORK_NOTICE_ROUTE_PATH = "/api/fork/notice";
export const FORK_NUDGE_ROUTE_PATH = "/api/fork/thread/nudge";
export const FORK_FREEZE_ROUTE_PATH = "/api/fork/freeze";
export const FORK_THAW_ROUTE_PATH = "/api/fork/thaw";

export const ClaudeImportRequest = Schema.Struct({
  ...ClaudeTranscriptSync.ClaudeImportOptions.fields,
  /** Import only this transcript (path or session id) instead of sweeping. */
  session: Schema.optional(Schema.String),
});
export type ClaudeImportRequest = typeof ClaudeImportRequest.Type;

export const ClaudeImportResponse = Schema.Struct({
  lines: Schema.Array(Schema.String),
  summary: Schema.String,
});
export type ClaudeImportResponse = typeof ClaudeImportResponse.Type;
export const decodeClaudeImportResponse = Schema.decodeUnknownOption(ClaudeImportResponse);

export const SessionResetRequest = Schema.Struct({
  threadId: Schema.String,
  apply: Schema.Boolean,
});
export type SessionResetRequest = typeof SessionResetRequest.Type;

export const SessionResetResponse = Schema.Struct({
  lines: Schema.Array(Schema.String),
  reset: Schema.Boolean,
});
export type SessionResetResponse = typeof SessionResetResponse.Type;
export const decodeSessionResetResponse = Schema.decodeUnknownOption(SessionResetResponse);

export const NoticeRequest = Schema.Struct({ message: Schema.String });
export type NoticeRequest = typeof NoticeRequest.Type;

export const NoticeResponse = Schema.Struct({ id: Schema.String });
export type NoticeResponse = typeof NoticeResponse.Type;
export const decodeNoticeResponse = Schema.decodeUnknownOption(NoticeResponse);

export const NudgeRequest = Schema.Struct({
  threadIds: Schema.Array(Schema.String),
  message: Schema.String,
  /** Makes a retried nudge a no-op instead of a second message. */
  nudgeId: Schema.String,
});
export type NudgeRequest = typeof NudgeRequest.Type;

export const NudgeResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ threadId: Schema.String, sent: Schema.Boolean, detail: Schema.String }),
  ),
});
export type NudgeResponse = typeof NudgeResponse.Type;
export const decodeNudgeResponse = Schema.decodeUnknownOption(NudgeResponse);

const BusyThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  reasons: Schema.Array(Schema.String),
});

export const FreezeRequest = Schema.Struct({
  /** `check` only reads what is busy; `freeze` stops it and disables scheduled tasks. */
  action: Schema.Literals(["check", "freeze"]),
  freezeId: Schema.String,
  keepThreads: Schema.Array(Schema.String),
  keepWorktrees: Schema.Array(Schema.String),
  waitSecs: Schema.Number,
});
export type FreezeRequest = typeof FreezeRequest.Type;

export const FreezeResponse = Schema.Struct({
  stopped: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  scheduledTasksDisabled: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  remaining: Schema.Array(BusyThread),
  errors: Schema.Array(Schema.String),
});
export type FreezeResponse = typeof FreezeResponse.Type;
export const decodeFreezeResponse = Schema.decodeUnknownOption(FreezeResponse);

export const ThawRequest = Schema.Struct({
  scheduledTaskIds: Schema.Array(Schema.String),
  threadIds: Schema.Array(Schema.String),
  /** Empty sends no nudge. */
  message: Schema.String,
  nudgeId: Schema.String,
});
export type ThawRequest = typeof ThawRequest.Type;

export const ThawResponse = Schema.Struct({
  scheduledTasks: Schema.Array(
    Schema.Struct({ id: Schema.String, enabled: Schema.Boolean, detail: Schema.String }),
  ),
  nudges: NudgeResponse.fields.results,
});
export type ThawResponse = typeof ThawResponse.Type;
export const decodeThawResponse = Schema.decodeUnknownOption(ThawResponse);

/** Body of every non-2xx response from these routes. */
export const ForkRouteFailure = Schema.Struct({ error: Schema.String });

const failure = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error } satisfies typeof ForkRouteFailure.Type, { status });

const decodeClaudeImportRequest = Schema.decodeUnknownOption(ClaudeImportRequest);
const decodeSessionResetRequest = Schema.decodeUnknownOption(SessionResetRequest);
const decodeNoticeRequest = Schema.decodeUnknownOption(NoticeRequest);
const decodeNudgeRequest = Schema.decodeUnknownOption(NudgeRequest);
const decodeFreezeRequest = Schema.decodeUnknownOption(FreezeRequest);
const decodeThawRequest = Schema.decodeUnknownOption(ThawRequest);

/** The JSON body, or `undefined` when it is missing or not JSON. */
const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const json = yield* request.json.pipe(Effect.option);
  return json._tag === "None" ? undefined : (json.value as unknown);
});

/** `POST /api/fork/import/claude-sync` — body `ClaudeImportRequest`. */
const claudeImportRoute = HttpRouter.add(
  "POST",
  FORK_CLAUDE_IMPORT_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeClaudeImportRequest(yield* readJsonBody);
    if (body._tag === "None") {
      return failure(400, "Invalid import request body.");
    }
    const sync = yield* ClaudeTranscriptSync.ClaudeTranscriptSync;
    const { session, ...options } = body.value;
    return yield* (
      session === undefined ? sync.sync(options) : sync.importSession({ ...options, session })
    ).pipe(
      Effect.map((report) =>
        HttpServerResponse.jsonUnsafe({
          lines: report.lines,
          summary: ClaudeTranscriptSync.formatSummary(report.counters),
        } satisfies ClaudeImportResponse),
      ),
      Effect.catchTags({
        ClaudeImportError: (error) => Effect.succeed(failure(422, error.message)),
      }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** `POST /api/fork/session/reset` — body `SessionResetRequest`. */
const sessionResetRoute = HttpRouter.add(
  "POST",
  FORK_SESSION_RESET_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeSessionResetRequest(yield* readJsonBody);
    if (body._tag === "None" || body.value.threadId.trim().length === 0) {
      return failure(400, "Invalid session reset request body.");
    }
    const bindings = yield* ClaudeResumeBindings.ClaudeResumeBindings;
    return yield* bindings
      .reset({ threadId: ThreadId.make(body.value.threadId.trim()), apply: body.value.apply })
      .pipe(
        Effect.map((result) =>
          HttpServerResponse.jsonUnsafe({
            lines: result.lines,
            reset: result.reset,
          } satisfies SessionResetResponse),
        ),
        Effect.catchTags({
          ClaudeResumeBindingError: (error) => Effect.succeed(failure(409, error.message)),
        }),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** `POST /api/fork/notice` — body `NoticeRequest`; shown to every connected client. */
const noticeRoute = HttpRouter.add(
  "POST",
  FORK_NOTICE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeNoticeRequest(yield* readJsonBody);
    const message = body._tag === "Some" ? body.value.message.trim() : "";
    if (message.length === 0) {
      return failure(400, "Invalid notice request body.");
    }
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    // Unique per notice and across restarts, which reset the stream's sequence.
    const id = String(yield* Clock.currentTimeMillis);
    yield* lifecycleEvents.publish({ version: 1, type: "notice", payload: { id, message } });
    return HttpServerResponse.jsonUnsafe({ id } satisfies NoticeResponse);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Queue `message` on each thread as a system notification; a thread that cannot take it is reported. */
const nudgeThreads = (input: {
  readonly threadIds: ReadonlyArray<string>;
  readonly message: string;
  readonly nudgeId: string;
  readonly summary: string;
}) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* Effect.forEach(input.threadIds, (rawId) => {
      const threadId = ThreadId.make(rawId.trim());
      return threads.getThreadRecords(threadId, []).pipe(
        Effect.flatMap(() =>
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:nudge:${input.nudgeId}:${threadId}`),
            threadId,
            messageId: MessageId.make(`message:nudge:${input.nudgeId}:${threadId}`),
            text: input.message,
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: input.summary,
              detail: input.message,
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          }),
        ),
        Effect.map(() => ({ threadId, sent: true, detail: "queued" })),
        Effect.catch((error: { readonly message: string }) =>
          Effect.succeed({ threadId, sent: false, detail: error.message }),
        ),
      );
    });
  });

/**
 * `POST /api/fork/thread/nudge` — body `NudgeRequest`. Queues `message` on each thread as a
 * system notification, like the restart continuation does, so the agent reads it as the
 * server talking rather than the user. A thread that cannot take it is reported, not fatal.
 */
const nudgeRoute = HttpRouter.add(
  "POST",
  FORK_NUDGE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeNudgeRequest(yield* readJsonBody);
    const message = body._tag === "Some" ? body.value.message.trim() : "";
    const nudgeId = body._tag === "Some" ? body.value.nudgeId.trim() : "";
    if (body._tag === "None" || message.length === 0 || nudgeId.length === 0) {
      return failure(400, "Invalid nudge request body.");
    }
    const results = yield* nudgeThreads({
      ...body.value,
      message,
      summary: "T3 Code was restarted by another thread",
    });
    return HttpServerResponse.jsonUnsafe({ results } satisfies NudgeResponse);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * `POST /api/fork/freeze` — body `FreezeRequest`. `check` lists the threads working right now;
 * `freeze` disables scheduled tasks and stops every working thread until the server is quiet.
 */
const freezeRoute = HttpRouter.add(
  "POST",
  FORK_FREEZE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeFreezeRequest(yield* readJsonBody);
    if (body._tag === "None" || body.value.freezeId.trim().length === 0) {
      return failure(400, "Invalid freeze request body.");
    }
    const filter = { keepThreads: body.value.keepThreads, keepWorktrees: body.value.keepWorktrees };
    if (body.value.action === "check") {
      const remaining = yield* Freeze.findBusyThreads(filter);
      return HttpServerResponse.jsonUnsafe({
        stopped: [],
        scheduledTasksDisabled: [],
        remaining,
        errors: [],
      } satisfies FreezeResponse);
    }
    const result = yield* Freeze.freezeThreads({
      freezeId: body.value.freezeId.trim(),
      filter,
      waitSecs: Math.max(0, body.value.waitSecs),
      reason: "Frozen by t3 freeze so usage can be measured in isolation.",
    });
    return HttpServerResponse.jsonUnsafe(result satisfies FreezeResponse);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** `POST /api/fork/thaw` — body `ThawRequest`; re-enables scheduled tasks and nudges stopped threads. */
const thawRoute = HttpRouter.add(
  "POST",
  FORK_THAW_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const body = decodeThawRequest(yield* readJsonBody);
    if (body._tag === "None" || body.value.nudgeId.trim().length === 0) {
      return failure(400, "Invalid thaw request body.");
    }
    const message = body.value.message.trim();
    const scheduledTasks = yield* Freeze.enableScheduledTasks(body.value.scheduledTaskIds);
    const nudges =
      message.length === 0
        ? []
        : yield* nudgeThreads({
            threadIds: body.value.threadIds,
            message,
            nudgeId: body.value.nudgeId.trim(),
            summary: "T3 Code was thawed after a freeze",
          });
    return HttpServerResponse.jsonUnsafe({ scheduledTasks, nudges } satisfies ThawResponse);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const forkRouteLayer = Layer.mergeAll(
  claudeImportRoute,
  sessionResetRoute,
  noticeRoute,
  nudgeRoute,
  freezeRoute,
  thawRoute,
);
