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
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import {
  FORK_CLAUDE_IMPORT_ROUTE_PATH,
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
