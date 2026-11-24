/**
 * `t3 import sync|claude|hook`: mirror Claude Code transcripts into T3 (work in
 * `import/ClaudeTranscriptSync.ts`). A systemd user timer runs `sync` every 15 minutes: keep the output
 * format (`<outcome> sessionId=…` lines plus a final `summary …` line) stable for its journal. `hook`
 * is what a Claude Code hook runs after each turn (docs/user/claude-code-handoff.md).
 */
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  type ClaudeImportResponse,
  decodeClaudeImportResponse,
  FORK_CLAUDE_IMPORT_ROUTE_PATH,
  type ClaudeImportRequest,
} from "../fork/http.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import { T3_CLAUDE_ENTRYPOINT } from "../import/syncPlan.ts";
import { projectLocationFlags } from "./config.ts";
import { ForkCliError, postForkRoute, runLiveOrOffline } from "./forkLive.ts";

const instanceFlag = Flag.String("instance").pipe(
  Flag.withDescription("claudeAgent provider instance id to attribute imported threads to."),
  Flag.optional,
);

const projectsDirFlag = Flag.String("projects-dir").pipe(
  Flag.withDescription(
    "Directory containing Claude project transcript folders (defaults to ~/.claude/projects of the user running the server).",
  ),
  Flag.optional,
);

const includeRalphFlag = Flag.Boolean("include-ralph").pipe(
  Flag.withDescription(
    "Also sync ralph harness transcripts (generator/evaluator/rescue agent runs), which are excluded by default.",
  ),
  Flag.withDefault(false),
);

/**
 * The server may run with another cwd: send absolute paths. `~` is left for
 * the server to expand (same user on the T3 host).
 */
const absolutize = Effect.fn("absolutizeImportPath")(function* (value: string) {
  const path = yield* Path.Path;
  return value.startsWith("~") || path.isAbsolute(value) ? value : path.resolve(value);
});

const runImport = (
  flags: Parameters<typeof runLiveOrOffline>[0]["flags"],
  request: ClaudeImportRequest,
) =>
  runLiveOrOffline({
    flags,
    live: ({ origin, token }) =>
      postForkRoute({
        origin,
        token,
        path: FORK_CLAUDE_IMPORT_ROUTE_PATH,
        body: request,
        decodeResponse: decodeClaudeImportResponse,
      }),
    offline: Effect.gen(function* () {
      const sync = yield* ClaudeTranscriptSync.ClaudeTranscriptSync;
      const { session, ...options } = request;
      const report = yield* (
        session === undefined ? sync.sync(options) : sync.importSession({ ...options, session })
      ).pipe(Effect.mapError((error) => new ForkCliError({ detail: error.message })));
      return {
        lines: report.lines,
        summary: ClaudeTranscriptSync.formatSummary(report.counters),
      } satisfies ClaudeImportResponse;
    }),
  });

const importClaudeCommand = Command.make("claude", {
  ...projectLocationFlags,
  instance: instanceFlag,
  projectsDir: projectsDirFlag,
  session: Argument.String("session").pipe(
    Argument.withDescription(
      "Path to a Claude transcript .jsonl file, or a Claude session id to locate under the projects dir.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Import (or incrementally update) one Claude Code conversation as a resumable T3 thread.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // A bare session id is looked up under the projects dir; anything path-like is a file.
      const session =
        flags.session.includes("/") || flags.session.endsWith(".jsonl")
          ? yield* absolutize(flags.session)
          : flags.session;
      const result = yield* runImport(flags, {
        session,
        ...(Option.isSome(flags.instance) ? { instance: flags.instance.value } : {}),
        ...(Option.isSome(flags.projectsDir)
          ? { projectsDir: yield* absolutize(flags.projectsDir.value) }
          : {}),
      });
      for (const line of result.lines) yield* Console.log(line);
    }),
  ),
);

/** The fields of Claude Code's hook input this command reads. */
const ClaudeHookInput = Schema.Struct({ transcript_path: Schema.String });
const decodeClaudeHookInput = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeHookInput));

const importHookCommand = Command.make("hook", {
  ...projectLocationFlags,
  instance: instanceFlag,
}).pipe(
  Command.withDescription(
    "Run from a Claude Code hook (Stop or SessionEnd): read the hook's JSON on stdin and import that " +
      "session, or bring its new turns into the T3 thread that continues it. Never fails the hook.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // A Claude that T3 itself runs: its turns already reach the thread.
      const environment = yield* HostProcess.Environment;
      if (environment.CLAUDE_CODE_ENTRYPOINT === T3_CLAUDE_ENTRYPOINT) return;
      const stdio = yield* Stdio.Stdio;
      const input = decodeClaudeHookInput(
        yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
      );
      if (Option.isNone(input) || input.value.transcript_path.trim().length === 0) {
        return yield* Console.error("t3 import hook: expected Claude Code hook JSON on stdin.");
      }
      const result = yield* runImport(flags, {
        session: yield* absolutize(input.value.transcript_path.trim()),
        ...(Option.isSome(flags.instance) ? { instance: flags.instance.value } : {}),
      });
      for (const line of result.lines) yield* Console.log(line);
    }).pipe(
      // Claude Code reports a failing hook after every turn; a T3 that is down is not the CLI's problem.
      Effect.catchCause((cause) => Console.error(`t3 import hook: ${Cause.pretty(cause)}`)),
    ),
  ),
);

const importSyncCommand = Command.make("sync", {
  ...projectLocationFlags,
  instance: instanceFlag,
  projectsDir: projectsDirFlag,
  includeRalph: includeRalphFlag,
}).pipe(
  Command.withDescription(
    "Scan every Claude transcript under the projects directory and create or incrementally update its T3 thread (fork-safe; runs inside the server when one is running).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* runImport(flags, {
        includeRalph: flags.includeRalph,
        ...(Option.isSome(flags.instance) ? { instance: flags.instance.value } : {}),
        ...(Option.isSome(flags.projectsDir)
          ? { projectsDir: yield* absolutize(flags.projectsDir.value) }
          : {}),
      });
      for (const line of result.lines) yield* Console.log(line);
      yield* Console.log(result.summary);
    }),
  ),
);

export const importCommand = Command.make("import").pipe(
  Command.withDescription("Import conversations from other coding agents into T3."),
  Command.withSubcommands([importClaudeCommand, importSyncCommand, importHookCommand]),
);
