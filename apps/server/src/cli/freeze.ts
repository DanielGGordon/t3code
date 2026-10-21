/**
 * `t3 freeze` / `t3 thaw` — stop every conversation on the running server so one measured task is
 * the only thing drawing on the Claude subscription, then bring the rest back.
 *
 * Freeze stops each working thread like the Stop button (background agents and commands included,
 * queues held) and disables scheduled tasks. What it touched is written to a manifest so `thaw` can
 * undo exactly that. Exit code 1 means something was still working when the wait ran out.
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  decodeFreezeResponse,
  decodeThawResponse,
  FORK_FREEZE_ROUTE_PATH,
  FORK_THAW_ROUTE_PATH,
  type FreezeResponse,
} from "../fork/http.ts";
import { projectLocationFlags } from "./config.ts";
import { ForkCliError, postForkRoute, runLiveOrOffline } from "./forkLive.ts";

const FreezeManifest = Schema.Struct({
  frozenAt: Schema.String,
  threads: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  scheduledTasks: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
});
type FreezeManifest = typeof FreezeManifest.Type;
const ManifestJson = Schema.fromJsonString(FreezeManifest);
const decodeManifest = Schema.decodeUnknownOption(ManifestJson);
const encodeManifest = Schema.encodeSync(ManifestJson);

// The same /tmp convention as the redeploy status files.
const defaultManifestPath = `${NodeOS.tmpdir()}/t3-freeze.json`;

const manifestFlag = Flag.String("manifest").pipe(
  Flag.withDescription(`Where freeze records what it stopped (default ${defaultManifestPath}).`),
  Flag.withDefault(defaultManifestPath),
);

/** The recorded freeze, or null when there is none (or it is unreadable). */
const readManifest = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    return Option.getOrNull(Option.flatMap(text, decodeManifest));
  });

const quoted = (text: string) => JSON.stringify(text);

export const freezeCommand = Command.make("freeze", {
  ...projectLocationFlags,
  keepThreads: Flag.String("keep-thread").pipe(
    Flag.withDescription(
      "A thread to leave running, usually the one doing the measured task. Repeatable.",
    ),
    Flag.atLeast(0),
  ),
  keepWorktrees: Flag.String("keep-worktree").pipe(
    Flag.withDescription("Leave running every thread whose git worktree is this path. Repeatable."),
    Flag.atLeast(0),
  ),
  waitSecs: Flag.Int("wait").pipe(
    Flag.withDescription("Seconds to keep stopping stragglers before giving up."),
    Flag.withDefault(90),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription(
      "Only list what is working right now; stop nothing. Exit 1 when anything is.",
    ),
    Flag.withDefault(false),
  ),
  manifest: manifestFlag,
}).pipe(
  Command.withDescription(
    "Stop every other conversation (and its background agents) and disable scheduled tasks.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (!flags.check && flags.keepThreads.length === 0 && flags.keepWorktrees.length === 0) {
        yield* Console.error(
          "freeze: no --keep-thread/--keep-worktree given, so this chat will be stopped too.",
        );
      }
      const freezeId = String(yield* Clock.currentTimeMillis);
      const result: FreezeResponse = yield* runLiveOrOffline({
        flags,
        live: ({ origin, token }) =>
          postForkRoute({
            origin,
            token,
            path: FORK_FREEZE_ROUTE_PATH,
            body: {
              action: flags.check ? "check" : "freeze",
              freezeId,
              keepThreads: flags.keepThreads,
              keepWorktrees: flags.keepWorktrees,
              waitSecs: flags.waitSecs,
            },
            decodeResponse: decodeFreezeResponse,
          }),
        offline: Effect.fail(
          new ForkCliError({ detail: "No T3 server is running; there is nothing to freeze." }),
        ),
      });

      for (const row of result.stopped) {
        yield* Console.log(`stopped ${row.threadId} ${quoted(row.title)}`);
      }
      for (const row of result.scheduledTasksDisabled) {
        yield* Console.log(`disabled-task ${row.id} ${quoted(row.title)}`);
      }
      for (const row of result.remaining) {
        yield* Console.log(`busy ${row.threadId} ${row.reasons.join(",")} ${quoted(row.title)}`);
      }
      for (const error of result.errors) {
        yield* Console.log(`error ${error}`);
      }

      if (!flags.check) {
        // Accumulate across repeated freezes so one thaw undoes all of them.
        const previous = yield* readManifest(flags.manifest);
        const frozenAt = DateTime.formatIso(yield* DateTime.now);
        const byId = <T extends object>(rows: ReadonlyArray<T>, key: (row: T) => string) => [
          ...new Map(rows.map((row) => [key(row), row])).values(),
        ];
        const manifest: FreezeManifest = {
          frozenAt: previous?.frozenAt ?? frozenAt,
          threads: byId([...(previous?.threads ?? []), ...result.stopped], (row) => row.threadId),
          scheduledTasks: byId(
            [...(previous?.scheduledTasks ?? []), ...result.scheduledTasksDisabled],
            (row) => row.id,
          ),
        };
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(flags.manifest), { recursive: true });
        yield* fs.writeFileString(flags.manifest, encodeManifest(manifest));
      }

      if (result.remaining.length > 0) {
        process.exitCode = 1;
        yield* Console.log(
          flags.check
            ? `NOT QUIET: ${result.remaining.length} thread(s) working.`
            : `NOT QUIET: ${result.remaining.length} thread(s) still working after ${flags.waitSecs}s.`,
        );
      } else {
        yield* Console.log(
          flags.check
            ? "QUIET: nothing else is working."
            : `FROZEN: quiet. Stopped ${result.stopped.length} thread(s), disabled ${result.scheduledTasksDisabled.length} scheduled task(s). Undo with: t3 thaw`,
        );
      }
    }),
  ),
);

const DEFAULT_THAW_MESSAGE =
  "T3 was frozen for a usage measurement and this conversation was stopped. Please continue where you left off.";

export const thawCommand = Command.make("thaw", {
  ...projectLocationFlags,
  noNudge: Flag.Boolean("no-nudge").pipe(
    Flag.withDescription("Do not send the stopped threads a message asking them to continue."),
    Flag.withDefault(false),
  ),
  message: Flag.String("message").pipe(
    Flag.withDescription("Text queued on each stopped thread."),
    Flag.withDefault(DEFAULT_THAW_MESSAGE),
  ),
  manifest: manifestFlag,
}).pipe(
  Command.withDescription(
    "Undo `t3 freeze`: re-enable scheduled tasks and ask the stopped threads to continue.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const manifest = yield* readManifest(flags.manifest);
      if (manifest === null) {
        return yield* new ForkCliError({
          detail: `No freeze manifest at ${flags.manifest}; nothing to thaw.`,
        });
      }
      const result = yield* runLiveOrOffline({
        flags,
        live: ({ origin, token }) =>
          postForkRoute({
            origin,
            token,
            path: FORK_THAW_ROUTE_PATH,
            body: {
              scheduledTaskIds: manifest.scheduledTasks.map((task) => task.id),
              threadIds: manifest.threads.map((thread) => thread.threadId),
              message: flags.noNudge ? "" : flags.message,
              nudgeId: `thaw-${manifest.frozenAt}`,
            },
            decodeResponse: decodeThawResponse,
          }),
        offline: Effect.fail(
          new ForkCliError({ detail: "No T3 server is running; there is nothing to thaw." }),
        ),
      });
      for (const row of result.scheduledTasks) {
        yield* Console.log(`${row.enabled ? "enabled-task" : "FAILED"} ${row.id} ${row.detail}`);
      }
      for (const row of result.nudges) {
        yield* Console.log(`${row.sent ? "nudged" : "FAILED"} ${row.threadId} ${row.detail}`);
      }
      const failed =
        result.scheduledTasks.some((row) => !row.enabled) || result.nudges.some((row) => !row.sent);
      // Keep the manifest when something failed so a retry still knows what to undo.
      if (!failed) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(flags.manifest, { force: true });
      } else process.exitCode = 1;
      yield* Console.log(failed ? "THAWED with failures (manifest kept)." : "THAWED.");
    }),
  ),
);
