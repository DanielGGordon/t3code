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
import { AuthOrchestrationOperateScope, ThreadId } from "@t3tools/contracts";
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

export const FORK_CLAUDE_IMPORT_ROUTE_PATH = "/api/fork/import/claude-sync";
export const FORK_SESSION_RESET_ROUTE_PATH = "/api/fork/session/reset";

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

/** Body of every non-2xx response from these routes. */
export const ForkRouteFailure = Schema.Struct({ error: Schema.String });

const failure = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error } satisfies typeof ForkRouteFailure.Type, { status });

const decodeClaudeImportRequest = Schema.decodeUnknownOption(ClaudeImportRequest);
const decodeSessionResetRequest = Schema.decodeUnknownOption(SessionResetRequest);

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

export const forkRouteLayer = Layer.mergeAll(claudeImportRoute, sessionResetRoute);
