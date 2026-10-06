/**
 * `t3 session audit|reset` — inspect and repair which native Claude session a
 * thread resumes. Logic lives in `import/ClaudeResumeBindings.ts`.
 *
 * `audit` is read-only SQL + filesystem checks, safe while the server runs.
 * `reset` writes an event, so it goes through the running server when there
 * is one (`cli/forkLive.ts`). The ClaudeAdapterV2 missing-transcript error
 * tells users to run `t3 session reset <threadId>`; keep the command names.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { decodeSessionResetResponse, FORK_SESSION_RESET_ROUTE_PATH } from "../fork/http.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { projectLocationFlags } from "./config.ts";
import { ForkCliError, postForkRoute, runLiveOrOffline, runOfflineRead } from "./forkLive.ts";

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const projectsDirFlag = Flag.String("projects-dir").pipe(
  Flag.withDescription(
    "Directory containing Claude project transcript folders (defaults to ~/.claude/projects).",
  ),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the audit as JSON, one object per line per reported thread."),
  Flag.withDefault(false),
);

const includeDeletedFlag = Flag.Boolean("include-deleted").pipe(
  Flag.withDescription("Also report threads that were deleted in T3."),
  Flag.withDefault(false),
);

const allFlag = Flag.Boolean("all").pipe(
  Flag.withDescription(
    "Report every Claude thread with a resume target, including those whose transcript is present.",
  ),
  Flag.withDefault(false),
);

/** Human-readable audit report (the JSON form is one row per line). */
export function formatAuditReport(input: {
  readonly rows: ReadonlyArray<ClaudeResumeBindings.SessionAuditRow>;
  readonly projectsRoot: string;
  readonly includeDeleted: boolean;
  readonly all: boolean;
}): ReadonlyArray<string> {
  const { rows } = input;
  const missing = rows.filter((row) => row.location.kind === "missing");
  const relocated = rows.filter((row) => row.location.kind === "relocated");
  const present = rows.filter((row) => row.location.kind === "present");
  const reported = input.all ? rows : rows.filter((row) => row.location.kind !== "present");
  const lines = [
    `Claude threads with a resume target: ${rows.length} ` +
      `(${present.length} transcript present, ${relocated.length} relocated, ${missing.length} missing)` +
      (input.includeDeleted ? "" : "; deleted threads not included") +
      `. Projects root: ${input.projectsRoot}`,
    ...reported.map(ClaudeResumeBindings.formatAuditRow),
  ];
  if (missing.length > 0) {
    lines.push(
      "\nMissing transcripts: sending in these threads fails with " +
        '"No conversation found with session ID". Copy each .jsonl back to the ' +
        "`expected=` path (e.g. from the machine where the conversation ran) and simply " +
        "send again, or run `t3 session reset <threadId> --yes` to start a fresh Claude session " +
        "with the thread's T3 history as context. Nothing is changed by this audit.",
    );
  }
  if (rows.some((row) => row.source === "legacy")) {
    lines.push(
      "\n`binding=legacy` rows are v1 resume cursors not bound yet; the next server start binds " +
        "the eligible ones (Claude threads with no T3 runs since the upgrade).",
    );
  }
  if (relocated.length > 0) {
    lines.push(
      "\nRelocated transcripts exist under a different project folder than the thread's " +
        "cwd; if sending fails, copy the `found=` file to the `expected=` path.",
    );
  }
  return lines;
}

const sessionAuditCommand = Command.make("audit", {
  ...projectLocationFlags,
  projectsDir: projectsDirFlag,
  json: jsonFlag,
  includeDeleted: includeDeletedFlag,
  all: allFlag,
}).pipe(
  Command.withDescription(
    "List Claude threads whose resume target points at a transcript missing from this machine (sending in them fails until the .jsonl is restored or the thread is reset). Read-only.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const projectsRoot = expandHomePath(
        Option.isSome(flags.projectsDir) ? flags.projectsDir.value : "~/.claude/projects",
      );
      const rows = yield* runOfflineRead(flags, () =>
        ClaudeResumeBindings.auditClaudeResumeTargets({
          projectsRoot,
          includeDeleted: flags.includeDeleted,
        }),
      );
      if (flags.json) {
        const reported = flags.all ? rows : rows.filter((row) => row.location.kind !== "present");
        for (const row of reported) yield* Console.log(encodeJsonString(row));
        return;
      }
      for (const line of formatAuditReport({
        rows,
        projectsRoot,
        includeDeleted: flags.includeDeleted,
        all: flags.all,
      })) {
        yield* Console.log(line);
      }
    }),
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDescription(
    "Actually reset the thread. Without this flag the command only reports what it would do.",
  ),
  Flag.withDefault(false),
);

const sessionResetCommand = Command.make("reset", {
  ...projectLocationFlags,
  yes: yesFlag,
  threadId: Argument.String("threadId").pipe(
    Argument.withDescription("T3 thread id whose provider session binding should be reset."),
  ),
}).pipe(
  Command.withDescription(
    "Detach a thread from its native provider session so its next message starts a fresh session with the thread's T3 history as context (use after `t3 session audit`).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const trimmed = flags.threadId.trim();
      if (trimmed.length === 0) {
        return yield* new ForkCliError({ detail: "threadId cannot be empty." });
      }
      const result = yield* runLiveOrOffline({
        flags,
        live: ({ origin, token }) =>
          postForkRoute({
            origin,
            token,
            path: FORK_SESSION_RESET_ROUTE_PATH,
            body: { threadId: trimmed, apply: flags.yes },
            decodeResponse: decodeSessionResetResponse,
          }),
        offline: Effect.gen(function* () {
          const bindings = yield* ClaudeResumeBindings.ClaudeResumeBindings;
          return yield* bindings
            .reset({ threadId: ThreadId.make(trimmed), apply: flags.yes })
            .pipe(Effect.mapError((error) => new ForkCliError({ detail: error.message })));
        }),
      });
      for (const line of result.lines) yield* Console.log(line);
    }),
  ),
);

export const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Inspect and repair provider session bindings (Claude resume targets)."),
  Command.withSubcommands([sessionAuditCommand, sessionResetCommand]),
);
