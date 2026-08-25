import { type OrchestrationThread, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { expandHomePath } from "../os-jank.ts";
import { claudeTranscriptRelativePath } from "../provider/claudeSessionTranscript.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { OfflineCliRuntimeLive } from "./offlineRuntime.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const encodeJsonString = Schema.encodeSync(Schema.UnknownFromJsonString);

class SessionCommandError extends Data.TaggedError("SessionCommandError")<{
  readonly message: string;
}> {}

/**
 * A Claude thread whose persisted binding will make the next send pass
 * `--resume <sessionId>` to Claude Code.
 */
export interface ClaudeResumeTarget {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd: string | undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract the resume target from a binding, or `undefined` for non-Claude
 * bindings and bindings without a resume session id (a fresh session will be
 * generated for those, so there is nothing to audit).
 */
export function readClaudeResumeTarget(
  binding: ProviderRuntimeBinding,
): ClaudeResumeTarget | undefined {
  if (binding.provider !== CLAUDE_DRIVER_KIND) return undefined;
  const sessionId = readStringField(binding.resumeCursor, "resume");
  if (sessionId === undefined) return undefined;
  return {
    threadId: binding.threadId,
    sessionId,
    cwd: readStringField(binding.runtimePayload, "cwd"),
  };
}

export type ThreadLifecycle = "active" | "archived" | "deleted" | "unknown";

export function threadLifecycle(thread: OrchestrationThread | undefined): ThreadLifecycle {
  if (thread === undefined) return "unknown";
  if (thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  return "active";
}

export type TranscriptLocation =
  | { readonly kind: "present"; readonly path: string }
  | { readonly kind: "relocated"; readonly expectedPath: string | undefined; readonly path: string }
  | { readonly kind: "missing"; readonly expectedPath: string | undefined };

export interface SessionAuditRow {
  readonly threadId: ThreadId;
  readonly title: string | undefined;
  readonly lifecycle: ThreadLifecycle;
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly location: TranscriptLocation;
}

export function formatAuditRow(row: SessionAuditRow): string {
  const parts = [
    `thread=${row.threadId}`,
    `lifecycle=${row.lifecycle}`,
    `title=${encodeJsonString(row.title ?? "")}`,
    `session=${row.sessionId}`,
    `cwd=${row.cwd ?? "?"}`,
  ];
  switch (row.location.kind) {
    case "missing":
      parts.push(`expected=${row.location.expectedPath ?? "?"}`);
      break;
    case "relocated":
      parts.push(`expected=${row.location.expectedPath ?? "?"}`, `found=${row.location.path}`);
      break;
    case "present":
      parts.push(`path=${row.location.path}`);
      break;
  }
  return parts.join(" ");
}

/**
 * Where Claude Code will look for the transcript. The expected location is
 * derived from the persisted cwd; as a fallback every project folder is
 * searched, because a transcript that moved (cwd renamed, worktree path
 * changed) is recoverable without copying anything.
 */
const locateTranscript = Effect.fn("locateTranscript")(function* (
  projectsRoot: string,
  projectDirs: ReadonlyArray<string>,
  target: ClaudeResumeTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expectedPath =
    target.cwd !== undefined
      ? path.join(projectsRoot, claudeTranscriptRelativePath(target.cwd, target.sessionId))
      : undefined;
  if (expectedPath !== undefined) {
    const exists = yield* fs.exists(expectedPath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return { kind: "present", path: expectedPath } satisfies TranscriptLocation;
    }
  }
  const fileName = `${target.sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, fileName);
    if (candidate === expectedPath) continue;
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return { kind: "relocated", expectedPath, path: candidate } satisfies TranscriptLocation;
    }
  }
  return { kind: "missing", expectedPath } satisfies TranscriptLocation;
});

const projectsDirFlag = Flag.string("projects-dir").pipe(
  Flag.withDescription(
    "Directory containing Claude project transcript folders (defaults to ~/.claude/projects).",
  ),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the audit as JSON, one object per line per reported thread."),
);

const includeDeletedFlag = Flag.boolean("include-deleted").pipe(
  Flag.withDescription("Also report threads that were deleted in T3."),
);

const allFlag = Flag.boolean("all").pipe(
  Flag.withDescription(
    "Report every Claude thread with a resume cursor, including those whose transcript is present.",
  ),
);

const sessionAuditCommand = Command.make("audit", {
  ...projectLocationFlags,
  projectsDir: projectsDirFlag,
  json: jsonFlag,
  includeDeleted: includeDeletedFlag,
  all: allFlag,
}).pipe(
  Command.withDescription(
    "List Claude threads whose resume cursor points at a transcript that is missing from this machine (sending in them fails until the .jsonl is restored or the thread is reset).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;

      const fs = yield* FileSystem.FileSystem;
      const projectsRoot = Option.isSome(flags.projectsDir)
        ? flags.projectsDir.value
        : yield* expandHomePath("~/.claude/projects");
      const projectDirs = yield* fs
        .readDirectory(projectsRoot)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

      const rows = yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new SessionCommandError({
                message: `Failed to read orchestration snapshot: ${String(cause)}.`,
              }),
          ),
        );
        const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
        const bindings = yield* directory.listBindings().pipe(
          Effect.mapError(
            (cause) =>
              new SessionCommandError({
                message: `Failed to read provider session bindings: ${String(cause)}.`,
              }),
          ),
        );

        const collected: Array<SessionAuditRow> = [];
        for (const binding of bindings) {
          const target = readClaudeResumeTarget(binding);
          if (target === undefined) continue;
          const thread = threadsById.get(target.threadId);
          const lifecycle = threadLifecycle(thread);
          if (lifecycle === "deleted" && !flags.includeDeleted) continue;
          const location = yield* locateTranscript(projectsRoot, projectDirs, target);
          collected.push({
            threadId: target.threadId,
            title: thread?.title,
            lifecycle,
            sessionId: target.sessionId,
            cwd: target.cwd,
            location,
          });
        }
        return collected;
      }).pipe(
        Effect.provide(
          OfflineCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      const missing = rows.filter((row) => row.location.kind === "missing");
      const relocated = rows.filter((row) => row.location.kind === "relocated");
      const present = rows.filter((row) => row.location.kind === "present");
      const lifecycleOrder: Record<ThreadLifecycle, number> = {
        active: 0,
        archived: 1,
        unknown: 2,
        deleted: 3,
      };
      const byLifecycle = (a: SessionAuditRow, b: SessionAuditRow) =>
        lifecycleOrder[a.lifecycle] - lifecycleOrder[b.lifecycle] ||
        a.threadId.localeCompare(b.threadId);
      const reported = (flags.all ? rows : [...missing, ...relocated]).sort(byLifecycle);

      if (flags.json) {
        for (const row of reported) {
          yield* Console.log(encodeJsonString(row));
        }
        return;
      }

      yield* Console.log(
        `Claude threads with a resume cursor: ${rows.length} ` +
          `(${present.length} transcript present, ${relocated.length} relocated, ${missing.length} missing)` +
          (flags.includeDeleted ? "" : "; deleted threads not included") +
          `. Projects root: ${projectsRoot}`,
      );
      for (const row of reported) {
        yield* Console.log(formatAuditRow(row));
      }
      if (missing.length > 0) {
        yield* Console.log(
          "\nMissing transcripts: sending in these threads fails with " +
            '"No conversation found with session ID". Copy each .jsonl back to the ' +
            "`expected=` path (e.g. from the machine where the conversation ran) and simply " +
            "send again, or run `t3 session reset <threadId>` to start a fresh Claude session " +
            "without the earlier context. Nothing is changed by this audit.",
        );
      }
      if (relocated.length > 0) {
        yield* Console.log(
          "\nRelocated transcripts exist under a different project folder than the thread's " +
            "cwd; Claude Code usually resolves these on its own. If sending still fails, copy the " +
            "`found=` file to the `expected=` path.",
        );
      }
    }),
  ),
);

const yesFlag = Flag.boolean("yes").pipe(
  Flag.withDescription(
    "Actually clear the resume cursor. Without this flag the command only reports what it would do.",
  ),
);

const sessionResetCommand = Command.make("reset", {
  ...projectLocationFlags,
  yes: yesFlag,
  threadId: Argument.string("threadId").pipe(
    Argument.withDescription("T3 thread id whose provider resume cursor should be cleared."),
  ),
}).pipe(
  Command.withDescription(
    "Clear a thread's persisted resume cursor so its next message starts a fresh provider session (use after `t3 session audit`; the thread's T3 history is kept, the provider-side context is not).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;
      const trimmed = flags.threadId.trim();
      if (trimmed.length === 0) {
        return yield* new SessionCommandError({ message: "threadId cannot be empty." });
      }
      const threadId = ThreadId.make(trimmed);

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const binding = Option.getOrUndefined(
          yield* directory.getBinding(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCommandError({
                  message: `Failed to read the provider session binding: ${String(cause)}.`,
                }),
            ),
          ),
        );
        if (binding === undefined) {
          return yield* new SessionCommandError({
            message: `Thread ${threadId} has no provider session binding; nothing to reset.`,
          });
        }
        if (binding.resumeCursor === null || binding.resumeCursor === undefined) {
          yield* Console.log(
            `Thread ${threadId} (${binding.provider}) has no resume cursor; its next message already starts a fresh session.`,
          );
          return;
        }

        const cursorJson = encodeJsonString(binding.resumeCursor);
        yield* Console.log(
          [
            `Thread ${threadId} (${binding.provider}${binding.providerInstanceId ? `, instance ${binding.providerInstanceId}` : ""})`,
            `  current resume cursor: ${cursorJson}`,
            `  keep this line if you may want to restore the cursor by hand later.`,
          ].join("\n"),
        );

        if (!flags.yes) {
          yield* Console.log(
            "Dry run: no changes made. Re-run with --yes to clear the cursor. " +
              "If the transcript can still be recovered from another machine, restore it instead of resetting.",
          );
          return;
        }

        yield* directory
          .upsert({
            threadId,
            provider: binding.provider,
            ...(binding.providerInstanceId !== undefined
              ? { providerInstanceId: binding.providerInstanceId }
              : {}),
            resumeCursor: null,
            status: "stopped",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionCommandError({
                  message: `Failed to clear the resume cursor: ${String(cause)}.`,
                }),
            ),
          );
        yield* Console.log(
          `Cleared the resume cursor for thread ${threadId}. Its next message starts a fresh ${binding.provider} session ` +
            "(T3 history stays; provider-side context does not). Takes effect on the next session start — " +
            "if the server currently holds a live provider process for this thread, stop that thread first.",
        );
      }).pipe(
        Effect.provide(
          OfflineCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );
    }),
  ),
);

export const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Inspect and repair provider session bindings (resume cursors)."),
  Command.withSubcommands([sessionAuditCommand, sessionResetCommand]),
);
