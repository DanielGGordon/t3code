/**
 * `t3 nudge --message <text> <threadId>...` — queue a system message on running threads of the
 * live server. The force-redeploy script uses it after a restart that cut those threads off.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { decodeNudgeResponse, FORK_NUDGE_ROUTE_PATH } from "../fork/http.ts";
import { projectLocationFlags } from "./config.ts";
import { ForkCliError, postForkRoute, runLiveOrOffline } from "./forkLive.ts";

export const nudgeCommand = Command.make("nudge", {
  ...projectLocationFlags,
  message: Flag.String("message").pipe(
    Flag.withDescription("Text queued on each thread as a system message."),
  ),
  nudgeId: Flag.String("id").pipe(
    Flag.withDescription("Idempotency key: re-running with the same id sends nothing twice."),
    Flag.optional,
  ),
  threadIds: Argument.String("threadId").pipe(Argument.variadic),
}).pipe(
  Command.withDescription(
    "Queue a message on threads of the running server (e.g. after a restart).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = flags.message.trim();
      if (message.length === 0 || flags.threadIds.length === 0) {
        return yield* new ForkCliError({
          detail: "a message and at least one threadId are required.",
        });
      }
      const nudgeId = Option.isSome(flags.nudgeId)
        ? flags.nudgeId.value
        : String(yield* Clock.currentTimeMillis);
      const result = yield* runLiveOrOffline({
        flags,
        live: ({ origin, token }) =>
          postForkRoute({
            origin,
            token,
            path: FORK_NUDGE_ROUTE_PATH,
            body: { threadIds: flags.threadIds, message, nudgeId },
            decodeResponse: decodeNudgeResponse,
          }),
        offline: Effect.fail(
          new ForkCliError({ detail: "No T3 server is running; there is nobody to nudge." }),
        ),
      });
      for (const row of result.results) {
        yield* Console.log(`${row.sent ? "nudged" : "FAILED"} ${row.threadId} ${row.detail}`);
      }
    }),
  ),
);
