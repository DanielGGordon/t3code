// @effect-diagnostics nodeBuiltinImport:off - test fixtures write transcript files.
/**
 * Test fixtures for the fork's Claude import / resume-binding services: an
 * in-memory v2 database with the real EventSink + ProjectionStore, and
 * helpers to write Claude transcripts and v2 threads.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type OrchestrationV2AppThread,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

/** JSON text for SQL fixtures. */
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

export function makeTempDir(prefix: string): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${prefix}-`));
}

export interface TranscriptMessage {
  readonly uuid: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
}

/** Write `<projectsDir>/<encoded cwd>/<sessionId>.jsonl` and return its path. */
export function writeTranscript(input: {
  readonly projectsDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly messages: ReadonlyArray<TranscriptMessage>;
}): string {
  const dir = NodePath.join(input.projectsDir, input.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  NodeFS.mkdirSync(dir, { recursive: true });
  const lines = input.messages.map((message, index) =>
    JSON.stringify({
      type: message.role,
      uuid: message.uuid,
      sessionId: input.sessionId,
      cwd: input.cwd,
      gitBranch: "main",
      timestamp: message.timestamp ?? `2026-09-01T10:00:${String(index).padStart(2, "0")}.000Z`,
      message:
        message.role === "user"
          ? { role: "user", content: message.text }
          : { role: "assistant", content: [{ type: "text", text: message.text }] },
    }),
  );
  const file = NodePath.join(dir, `${input.sessionId}.jsonl`);
  NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);

/** In-memory database + real EventSink/ProjectionStore. */
export const layerV2Database = Layer.mergeAll(
  layerStores,
  EventSink.layer.pipe(Layer.provide(layerStores)),
);

/** A ProjectService stand-in that records created projects in memory. */
export function layerProjectsMock() {
  const projects: Array<Project> = [];
  return Layer.mock(ProjectService.ProjectService)({
    snapshot: Effect.sync(() => ({
      projects: [...projects],
      updatedAt: "2026-09-01T00:00:00.000Z",
    })) as never,
    create: (input) =>
      Effect.sync(() => {
        const project = {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          deletedAt: null,
        } as unknown as Project;
        projects.push(project);
        return project;
      }),
  });
}

export function layerImportEnvironment(input: { readonly worktreesDir: string }) {
  return Layer.mergeAll(
    layerProjectsMock(),
    ServerSettings.layerTest().pipe(Layer.orDie),
    // Only `worktreesDir` is read by the import services.
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: input.worktreesDir } as never),
    NodeServices.layer,
  );
}

/** Create a plain v2 thread through the event sink. */
export const createThread = Effect.fn("createThread")(function* (input: {
  readonly threadId: string;
  readonly historyOrigin?: OrchestrationV2AppThread["historyOrigin"];
  readonly projectId?: string;
  readonly worktreePath?: string | null;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const at = DateTime.makeUnsafe("2026-08-01T00:00:00.000Z");
  const threadId = ThreadId.make(input.threadId);
  const thread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: ProjectId.make(input.projectId ?? "project:fixture"),
    title: `Thread ${input.threadId}`,
    providerInstanceId: CLAUDE_INSTANCE,
    modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath ?? null,
    activeProviderThreadId: null,
    ...(input.historyOrigin === undefined ? {} : { historyOrigin: input.historyOrigin }),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  } as OrchestrationV2AppThread;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`fixture:thread:${input.threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: CLAUDE_INSTANCE,
        occurredAt: at,
        payload: thread,
      },
    ],
  });
  return thread;
});
