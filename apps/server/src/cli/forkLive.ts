/**
 * Fork: run a `t3 import` / `t3 session` write either through the running
 * server (`fork/http.ts` routes) or, when no server is running, in-process
 * against the SQLite state.
 *
 * Writing v2 events from a second process while the server serves would skip
 * its live event publication and race its writers, so when a server answers
 * the CLI never falls back to writing locally — a failing live request is an
 * error, not a reason to go offline. Likewise a server whose recorded pid is
 * alive but which does not answer the probe fails the run
 * (`ProjectLiveServerUnresponsiveError`); only a dead pid means offline.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ForkRouteFailure } from "../fork/http.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  layerProjectCliRuntime,
  tryResolveLiveProjectExecutionMode,
  withProjectCliSessionToken,
} from "./project.ts";

export class ForkCliError extends Schema.TaggedError<ForkCliError>()("ForkCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const decodeFailure = Schema.decodeUnknownOption(ForkRouteFailure);

/** POST `body` to a fork route on the live server and decode the reply. */
export const postForkRoute = <A>(input: {
  readonly origin: string;
  readonly token: string;
  readonly path: string;
  readonly body: unknown;
  readonly decodeResponse: (payload: unknown) => Option.Option<A>;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL(input.path, input.origin)).pipe(
          HttpClientRequest.bearerToken(input.token),
          HttpClientRequest.bodyJsonUnsafe(input.body),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ForkCliError({
              detail: `Request to the running server failed: ${describe(cause)}`,
            }),
        ),
      );
    const json = yield* response.json.pipe(Effect.option);
    const payload = Option.getOrUndefined(json);
    if (response.status < 200 || response.status >= 300) {
      const failure = decodeFailure(payload);
      return yield* new ForkCliError({
        detail:
          failure._tag === "Some"
            ? failure.value.error
            : response.status === 404
              ? `The running server does not support ${input.path}; it predates this CLI. ` +
                "Redeploy/restart the server (writes are not done offline while a server runs)."
              : `The running server answered HTTP ${response.status} for ${input.path}.`,
      });
    }
    const decoded = input.decodeResponse(payload);
    if (decoded._tag === "None") {
      return yield* new ForkCliError({
        detail: `Unexpected response from the running server for ${input.path}.`,
      });
    }
    return decoded.value;
  });

const layerOfflineServices = Layer.mergeAll(
  ClaudeTranscriptSync.layer,
  ClaudeResumeBindings.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerEventSink),
  Layer.provideMerge(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provideMerge(layerProjectCliRuntime),
);

export type ForkOfflineServices =
  | ClaudeTranscriptSync.ClaudeTranscriptSync
  | ClaudeResumeBindings.ClaudeResumeBindings;

/**
 * Run `live` against the running server when one answers, else `offline`
 * in-process with the import/session services over the state database.
 */
export const runLiveOrOffline = <A>(input: {
  readonly flags: CliAuthLocationFlags;
  readonly live: (server: {
    readonly origin: string;
    readonly token: string;
  }) => Effect.Effect<A, ForkCliError, HttpClient.HttpClient>;
  readonly offline: Effect.Effect<A, ForkCliError, ForkOfflineServices>;
}) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(input.flags, logLevel);
    const minimumLogLevel = config.logLevel;

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);
      if (Option.isSome(liveMode)) {
        return yield* withProjectCliSessionToken(environmentAuth, (token) =>
          input.live({ origin: liveMode.value.origin, token }),
        );
      }
      return yield* input.offline.pipe(
        Effect.provide(
          layerOfflineServices.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.layerRuntime, WorkspacePaths.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

/** Resolve CLI config and run a read-only effect over the state database. */
export const runOfflineRead = <A, E, R>(
  flags: CliAuthLocationFlags,
  effect: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* effect(config).pipe(
      Effect.provide(
        SqlitePersistence.layerConfig.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });
