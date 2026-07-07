import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestrationReadModel,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { parseClaudeTranscript, type ParsedClaudeSession } from "../import/claudeTranscript.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expandHomePath } from "../os-jank.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CLAUDE_ADAPTER_KEY = "claudeAgent";

class ImportCommandError extends Data.TaggedError("ImportCommandError")<{
  readonly message: string;
}> {}

/**
 * Offline runtime for `t3 import`. Mirrors `ProjectCliRuntimeLive`
 * (orchestration engine + projection snapshot + sqlite + workspace paths)
 * and additionally provides the provider session directory (so we can seed
 * the resume binding) and server settings (so we can resolve the Claude
 * provider instance). `FileSystem`, `Path`, and `Crypto` are satisfied by the
 * ambient CLI runtime layer (NodeServices) provided in `bin.ts`.
 */
const ImportCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
  OrchestrationLayerLive,
).pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const claudeModel = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND] ?? "claude-sonnet-5";

const claudeUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(() => new ImportCommandError({ message: "Failed to generate an identifier." })),
);

/**
 * Resolve the transcript file. The positional argument is either a path to a
 * `.jsonl` file or a Claude session id; for the latter we glob
 * `~/.claude/projects/*​/<id>.jsonl`.
 */
const resolveTranscript = Effect.fn("resolveTranscript")(function* (sessionArg: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const trimmed = sessionArg.trim();
  if (trimmed.length === 0) {
    return yield* new ImportCommandError({ message: "Session argument cannot be empty." });
  }

  // Treat the argument as a direct file path first.
  const asPathExists = yield* fs.exists(trimmed).pipe(Effect.orElseSucceed(() => false));
  if (asPathExists) {
    const content = yield* fs.readFileString(trimmed).pipe(
      Effect.mapError(
        (cause) =>
          new ImportCommandError({
            message: `Failed to read transcript '${trimmed}': ${String(cause)}.`,
          }),
      ),
    );
    const base = path.basename(trimmed);
    const sessionIdFromFilename = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
    return { content, sessionIdFromFilename };
  }

  // Otherwise treat the argument as a session id and search the Claude
  // projects directories: ~/.claude/projects/<encoded-cwd>/<id>.jsonl
  const projectsRoot = yield* expandHomePath("~/.claude/projects");
  const projectDirs = yield* fs
    .readDirectory(projectsRoot)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  const fileName = `${trimmed}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, fileName);
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const content = yield* fs.readFileString(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({
              message: `Failed to read transcript '${candidate}': ${String(cause)}.`,
            }),
        ),
      );
      return { content, sessionIdFromFilename: trimmed };
    }
  }

  return yield* new ImportCommandError({
    message:
      `Could not find a Claude transcript for '${trimmed}'. Pass a path to a .jsonl file ` +
      `or a session id present under ${projectsRoot}/*/.`,
  });
});

/**
 * Resolve the Claude provider instance id to use for the imported thread and
 * its resume binding.
 */
const resolveClaudeInstanceId = Effect.fn("resolveClaudeInstanceId")(function* (
  explicitInstance: Option.Option<string>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new ImportCommandError({
          message: `Failed to read server settings: ${String(cause)}.`,
        }),
    ),
  );

  const claudeInstanceIds = Object.entries(current.providerInstances)
    .filter(([, config]) => config.driver === CLAUDE_DRIVER_KIND)
    .map(([id]) => ProviderInstanceId.make(id));

  if (Option.isSome(explicitInstance)) {
    const requested = ProviderInstanceId.make(explicitInstance.value.trim());
    const exists = claudeInstanceIds.some((id) => id === requested);
    // Accept the canonical default even if it is not materialized in
    // providerInstances (it is hydrated implicitly from legacy settings).
    if (!exists && requested !== defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND)) {
      return yield* new ImportCommandError({
        message: `--instance '${requested}' is not a configured claudeAgent provider instance.`,
      });
    }
    return requested;
  }

  if (claudeInstanceIds.length === 1) {
    return claudeInstanceIds[0]!;
  }
  if (claudeInstanceIds.length === 0) {
    // Fall back to the canonical default; the registry hydrates this from
    // legacy `settings.providers.claudeAgent`.
    return defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
  }

  return yield* new ImportCommandError({
    message:
      "Multiple claudeAgent provider instances are configured. " +
      `Pass --instance with one of: ${claudeInstanceIds.join(", ")}.`,
  });
});

const runImport = Effect.fn("runImport")(function* (input: {
  readonly session: ParsedClaudeSession;
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: OrchestrationReadModel;
}) {
  const { session, instanceId, snapshot } = input;
  const path = yield* Path.Path;

  const cwd = session.cwd;
  if (cwd === null || cwd.trim().length === 0) {
    return yield* new ImportCommandError({
      message:
        "The transcript has no working directory (cwd); cannot create a project for the import.",
    });
  }
  const workspaceRoot = cwd.trim();

  if (session.sessionId.trim().length === 0) {
    return yield* new ImportCommandError({
      message: "The transcript has no session id and none could be derived from the filename.",
    });
  }
  const sessionId = session.sessionId.trim();

  const modelSelection: ModelSelection = {
    instanceId,
    model: claudeModel,
  };

  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const projectCreatedAt: IsoDateTime = session.startedAt ?? nowIso;
  const threadCreatedAt: IsoDateTime = session.startedAt ?? nowIso;

  // Deterministic ids so re-import dedupes via command receipts.
  const threadId = ThreadId.make(`claude-import-${sessionId}`);

  const engine = yield* OrchestrationEngineService;

  // 1. Project: dedupe by workspaceRoot against the snapshot.
  const existingProject = snapshot.projects.find(
    (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
  );
  let projectId: ProjectId;
  if (existingProject) {
    projectId = existingProject.id;
  } else {
    projectId = ProjectId.make(yield* claudeUuid);
    const projectTitle = (() => {
      const base = path.basename(workspaceRoot).trim();
      if (base.length > 0) return base;
      const fromSession = session.title?.trim();
      return fromSession && fromSession.length > 0 ? fromSession : "project";
    })();
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(`import:${threadId}:project-create`),
        projectId,
        title: projectTitle,
        workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt: projectCreatedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({ message: `Failed to create project: ${String(cause)}.` }),
        ),
      );
  }

  // 2. Thread.
  const threadTitle = session.title?.trim();
  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.make(`import:${threadId}:thread-create`),
      threadId,
      projectId,
      title: threadTitle && threadTitle.length > 0 ? threadTitle : "Imported Claude session",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: session.gitBranch,
      worktreePath: null,
      createdAt: threadCreatedAt,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ImportCommandError({ message: `Failed to create thread: ${String(cause)}.` }),
      ),
    );

  // 3. Messages, chronological, backdated.
  let imported = 0;
  for (const message of session.messages) {
    const createdAt: IsoDateTime =
      message.timestamp.trim().length > 0 ? message.timestamp : threadCreatedAt;
    yield* engine
      .dispatch({
        type: "thread.message.import",
        commandId: CommandId.make(`import:${threadId}:msg:${message.uuid}`),
        threadId,
        messageId: MessageId.make(message.uuid),
        role: message.role,
        text: message.text,
        turnId: null,
        createdAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({
              message: `Failed to import message ${message.uuid}: ${String(cause)}.`,
            }),
        ),
      );
    imported += 1;
  }

  // 4. Seed the resume binding. Resume is driven by this binding's
  // resumeCursor; providerInstanceId MUST equal the thread's modelSelection
  // instanceId. forkSession ensures continuing forks to a new transcript.
  const directory = yield* ProviderSessionDirectory;
  yield* directory
    .upsert({
      threadId,
      provider: CLAUDE_DRIVER_KIND,
      providerInstanceId: instanceId,
      adapterKey: CLAUDE_ADAPTER_KEY,
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { resume: sessionId, forkSession: true },
      runtimePayload: {
        cwd: workspaceRoot,
        model: claudeModel,
        activeTurnId: null,
        lastError: null,
        modelSelection,
      },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ImportCommandError({
            message: `Failed to seed resume binding: ${String(cause)}.`,
          }),
      ),
    );

  return {
    threadId,
    projectId,
    workspaceRoot,
    imported,
    reusedProject: existingProject !== undefined,
  };
});

const instanceFlag = Flag.string("instance").pipe(
  Flag.withDescription("claudeAgent provider instance id to attribute the imported thread to."),
  Flag.optional,
);

const importClaudeCommand = Command.make("claude", {
  ...projectLocationFlags,
  instance: instanceFlag,
  session: Argument.string("session").pipe(
    Argument.withDescription(
      "Path to a Claude transcript .jsonl file, or a Claude session id to locate under ~/.claude/projects.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Import an existing Claude Code conversation transcript as a resumable T3 thread.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;

      const transcript = yield* resolveTranscript(flags.session);
      const session = parseClaudeTranscript(transcript.content, {
        sessionIdFromFilename: transcript.sessionIdFromFilename,
      });

      const result = yield* Effect.gen(function* () {
        const instanceId = yield* resolveClaudeInstanceId(flags.instance);
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ImportCommandError({
                message: `Failed to read orchestration snapshot: ${String(cause)}.`,
              }),
          ),
        );
        return yield* runImport({ session, instanceId, snapshot });
      }).pipe(
        Effect.provide(
          ImportCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      yield* Console.log(
        [
          `Imported Claude session ${session.sessionId}.`,
          `  thread:   ${result.threadId}`,
          `  project:  ${result.projectId} (${result.reusedProject ? "reused" : "created"}) at ${result.workspaceRoot}`,
          `  messages: ${result.imported} imported`,
          `  resume:   wired (forkSession on — continuing forks a new Claude transcript)`,
        ].join("\n"),
      );
    }),
  ),
);

export const importCommand = Command.make("import").pipe(
  Command.withDescription("Import conversations from other coding agents into T3."),
  Command.withSubcommands([importClaudeCommand]),
);
