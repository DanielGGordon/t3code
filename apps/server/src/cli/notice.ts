/**
 * `t3 notice <message>` — show a message to every client connected to the
 * running server (`fork/http.ts` route, published on the server lifecycle
 * stream). The deploy script uses it to announce a restart.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { decodeNoticeResponse, FORK_NOTICE_ROUTE_PATH } from "../fork/http.ts";
import { projectLocationFlags } from "./config.ts";
import { ForkCliError, postForkRoute, runLiveOrOffline } from "./forkLive.ts";

export const noticeCommand = Command.make("notice", {
  ...projectLocationFlags,
  message: Argument.String("message").pipe(
    Argument.withDescription("Text shown to every connected client."),
  ),
}).pipe(
  Command.withDescription(
    "Show a message to everyone connected to the running server (e.g. an upcoming restart).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = flags.message.trim();
      if (message.length === 0) {
        return yield* new ForkCliError({ detail: "message cannot be empty." });
      }
      const result = yield* runLiveOrOffline({
        flags,
        live: ({ origin, token }) =>
          postForkRoute({
            origin,
            token,
            path: FORK_NOTICE_ROUTE_PATH,
            body: { message },
            decodeResponse: decodeNoticeResponse,
          }),
        offline: Effect.fail(
          new ForkCliError({ detail: "No T3 server is running; there is nobody to notify." }),
        ),
      });
      yield* Console.log(`notice ${result.id} published`);
    }),
  ),
);
