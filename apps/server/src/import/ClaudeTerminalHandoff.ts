/**
 * Fork: hand a Claude thread to the Claude Code CLI and back; both resume one native session. T3's
 * live Claude process holds the conversation in memory, so it is released whenever the session
 * changes hands, or T3's next turn would miss the CLI's turns and branch the transcript.
 */
import {
  ClaudeSettings,
  ClaudeTerminalHandoffError,
  type ClaudeTerminalHandoffResult,
  type ClaudeTerminalPullResult,
  CommandId,
  type OrchestrationV2ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_DRIVER_KIND } from "./claudeResumeEvents.ts";
import * as ClaudeTranscriptSync from "./ClaudeTranscriptSync.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const RELEASE_REASON = "Claude Code CLI handoff";

/** Single-quote for a POSIX shell. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function claudeResumeCommand(input: {
  readonly cwd: string;
  readonly sessionId: string;
  /** Only when the instance keeps Claude's data somewhere other than `~/.claude`. */
  readonly configDir?: string | undefined;
}): string {
  const env =
    input.configDir === undefined ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(input.configDir)} `;
  return `cd ${shellQuote(input.cwd)} && ${env}claude --resume ${input.sessionId}`;
}

/** Live sessions; a stopped or failed one has no process to release. */
const isLiveSession = (session: OrchestrationV2ProviderSession) =>
  session.status !== "stopped" && session.status !== "error";

export interface ClaudeTerminalHandoffShape {
  /** Release T3's process for the thread and return the command that resumes it in a terminal. */
  readonly handOff: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeTerminalHandoffResult, ClaudeTerminalHandoffError>;
  /** Bring the CLI's turns into the thread now instead of waiting for a hook or a sweep. */
  readonly pull: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeTerminalPullResult, ClaudeTerminalHandoffError>;
  /** After a sync appended CLI turns: drop each thread's now-stale idle process. Never fails. */
  readonly releaseStaleSessions: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void>;
}

export class ClaudeTerminalHandoff extends Context.Service<
  ClaudeTerminalHandoff,
  ClaudeTerminalHandoffShape
>()("t3/import/ClaudeTerminalHandoff") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const transcriptSync = yield* ClaudeTranscriptSync.ClaudeTranscriptSync;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;

  const fail = (threadId: ThreadId, detail: string) =>
    Effect.fail(new ClaudeTerminalHandoffError({ threadId, detail }));

  const readThread = (threadId: ThreadId) =>
    orchestrator
      .getThreadRecords(threadId, ["providerThreads", "providerSessions", "runs"])
      .pipe(
        Effect.mapError(
          (cause) => new ClaudeTerminalHandoffError({ threadId, detail: cause.message }),
        ),
      );

  /** The thread's Claude session and where its Claude process runs. */
  const resolveTarget = Effect.fn("ClaudeTerminalHandoff.resolveTarget")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* readThread(threadId);
    const thread = records.thread;
    if (thread.deletedAt !== null) return yield* fail(threadId, "This thread was deleted.");
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    if (providerThread === undefined || providerThread.driver !== CLAUDE_DRIVER_KIND) {
      return yield* fail(
        threadId,
        "Only a Claude thread with a conversation can continue in Claude Code.",
      );
    }
    const sessionId = providerThread.nativeThreadRef?.nativeId ?? null;
    if (sessionId === null) {
      return yield* fail(threadId, "Send a message first: this thread has no Claude session yet.");
    }
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const cwd = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    if (cwd === undefined) {
      return yield* fail(threadId, "This thread's project folder could not be found.");
    }
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new ClaudeTerminalHandoffError({ threadId, detail: cause.message }),
      ),
    );
    const instance = current.providerInstances[providerThread.providerInstanceId];
    const configured = instance?.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const configDir = yield* resolveClaudeHomePath(
      Option.getOrElse(decodeClaudeSettings(instance?.config ?? {}), () => ({ homePath: "" })),
      {
        CLAUDE_CONFIG_DIR:
          typeof configured === "string" ? configured : hostEnvironment.CLAUDE_CONFIG_DIR,
      },
    ).pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    );
    return { records, sessionId, cwd, configDir };
  });

  const commandId = (threadId: ThreadId, what: string) =>
    Effect.map(randomUuidV4, (uuid) =>
      CommandId.make(`claude-handoff:${what}:${threadId}:${uuid}`),
    );

  const releaseSessions = Effect.fn("ClaudeTerminalHandoff.releaseSessions")(function* (
    threadId: ThreadId,
    sessions: ReadonlyArray<OrchestrationV2ProviderSession>,
  ) {
    for (const session of sessions.filter(isLiveSession)) {
      yield* orchestrator.dispatch({
        type: "provider-session.detach",
        commandId: yield* commandId(threadId, `detach:${session.id}`),
        threadId,
        providerSessionId: session.id,
        reason: RELEASE_REASON,
      });
    }
  });

  const handOff: ClaudeTerminalHandoffShape["handOff"] = Effect.fn("ClaudeTerminalHandoff.handOff")(
    function* (threadId) {
      const target = yield* resolveTarget(threadId);
      const { thread, runs, providerSessions } = target.records;
      if (runs.some(isActiveRun)) {
        return yield* fail(threadId, "Wait for the current turn to finish, or stop it, first.");
      }
      const toError = (cause: { readonly message: string }) =>
        new ClaudeTerminalHandoffError({ threadId, detail: cause.message });
      // Keep-alive pings and compaction would write to the session while the CLI holds it.
      const keepAliveStopped =
        thread.cacheKeepAlive != null && thread.cacheKeepAlive.inherited !== true;
      if (keepAliveStopped) {
        yield* orchestrator
          .dispatch({
            type: "thread.cache-keep-alive.set",
            commandId: yield* commandId(threadId, "keep-alive-off"),
            threadId,
            enabled: false,
          })
          .pipe(Effect.mapError(toError));
      }
      yield* releaseSessions(threadId, providerSessions).pipe(Effect.mapError(toError));
      const defaultConfigDir = path.resolve(path.join(homeDirectory, ".claude"));
      return {
        sessionId: target.sessionId,
        cwd: target.cwd,
        command: claudeResumeCommand({
          cwd: target.cwd,
          sessionId: target.sessionId,
          configDir: target.configDir === defaultConfigDir ? undefined : target.configDir,
        }),
        keepAliveStopped,
      };
    },
  );

  const releaseStaleSessions: ClaudeTerminalHandoffShape["releaseStaleSessions"] = (threadIds) =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const records = yield* readThread(threadId);
          // A turn that started since the sync loaded the transcript itself.
          if (records.runs.some(isActiveRun)) return;
          yield* releaseSessions(threadId, records.providerSessions);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude-handoff.release-failed", { threadId, cause }),
          ),
        ),
      { discard: true },
    );

  const pull: ClaudeTerminalHandoffShape["pull"] = Effect.fn("ClaudeTerminalHandoff.pull")(
    function* (threadId) {
      const target = yield* resolveTarget(threadId);
      const report = yield* transcriptSync
        .importSession({
          session: target.sessionId,
          projectsDir: path.join(target.configDir, "projects"),
          instance: target.records.thread.providerInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) => new ClaudeTerminalHandoffError({ threadId, detail: cause.message }),
          ),
        );
      yield* releaseStaleSessions(report.continuedOutsideT3);
      return { appended: report.counters.appended };
    },
  );

  return ClaudeTerminalHandoff.of({ handOff, pull, releaseStaleSessions });
});

export const layer = Layer.effect(ClaudeTerminalHandoff, make);
