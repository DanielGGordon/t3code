// @effect-diagnostics nodeBuiltinImport:off - fixtures create workspace directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { deriveProviderThread } from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { providerThreadHasImportedNativeHistory } from "../orchestration-v2/ProviderTurnStartService.ts";
import {
  CLAUDE_INSTANCE,
  createThread,
  encodeJson,
  layerImportEnvironment,
  layerV2Database,
  makeTempDir,
  writeTranscript,
} from "./ClaudeImport.testkit.ts";
import { importedClaudeProviderThread } from "./claudeResumeEvents.ts";
import * as ClaudeTranscriptSync from "./ClaudeTranscriptSync.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function fixture() {
  const root = makeTempDir("claude-sync");
  const projectsDir = NodePath.join(root, "projects");
  const workspace = NodePath.join(root, "workspace");
  const worktreesDir = NodePath.join(root, "worktrees");
  NodeFS.mkdirSync(projectsDir, { recursive: true });
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(worktreesDir, { recursive: true });
  const layer = ClaudeTranscriptSync.layer.pipe(
    Layer.provideMerge(layerV2Database),
    Layer.provideMerge(layerImportEnvironment({ worktreesDir })),
  );
  return { projectsDir, workspace, worktreesDir, layer };
}

const baseMessages = [
  { uuid: "a-u1", role: "user" as const, text: "Fix the login bug" },
  { uuid: "a-a1", role: "assistant" as const, text: "Fixed it." },
];

const sync = (projectsDir: string) =>
  Effect.gen(function* () {
    const service = yield* ClaudeTranscriptSync.ClaudeTranscriptSync;
    return yield* service.sync({ projectsDir });
  });

describe("ClaudeTranscriptSync", () => {
  it.effect("creates a resumable thread, then stays idempotent and appends new messages", () => {
    const { projectsDir, workspace, layer } = fixture();
    return Effect.gen(function* () {
      writeTranscript({
        projectsDir,
        sessionId: SESSION_A,
        cwd: workspace,
        messages: baseMessages,
      });
      const first = yield* sync(projectsDir);
      assert.strictEqual(first.counters.created, 1, first.lines.join("\n"));

      const threadId = ThreadId.make(`claude-import-${SESSION_A}`);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(threadId, [
        "providerThreads",
        "messages",
        "runs",
      ]);
      assert.strictEqual(records.thread.historyOrigin, "v1_import");
      assert.strictEqual(records.thread.title, "Fix the login bug");
      assert.deepStrictEqual(
        records.messages.map((message) => [message.id, message.role, message.runId]),
        [
          ["a-u1", "user", null],
          ["a-a1", "assistant", null],
        ],
      );
      // A's resume contract: strong native ref to the session, firstRunOrdinal
      // null, and set as the thread's active provider thread.
      const active = records.providerThreads.find(
        (providerThread) => providerThread.id === records.thread.activeProviderThreadId,
      );
      assert.isDefined(active);
      assert.strictEqual(
        active!.id,
        deriveProviderThread({ driver: CLAUDE_DRIVER, nativeThreadId: SESSION_A }),
      );
      assert.deepStrictEqual(active!.nativeThreadRef, {
        driver: CLAUDE_DRIVER,
        nativeId: SESSION_A,
        strength: "strong",
      });
      assert.isNull(active!.nativeConversationHeadRef);
      assert.isTrue(providerThreadHasImportedNativeHistory(active!));
      assert.strictEqual(active!.providerInstanceId, CLAUDE_INSTANCE);

      const second = yield* sync(projectsDir);
      assert.strictEqual(second.counters.unchanged, 1, second.lines.join("\n"));
      assert.strictEqual(second.counters.created, 0);

      writeTranscript({
        projectsDir,
        sessionId: SESSION_A,
        cwd: workspace,
        messages: [...baseMessages, { uuid: "a-u2", role: "user", text: "One more thing" }],
      });
      const third = yield* sync(projectsDir);
      assert.strictEqual(third.counters.updated, 1, third.lines.join("\n"));
      assert.strictEqual(third.counters.appended, 1);
      const after = yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
      assert.deepStrictEqual(
        after.messages.map((message) => message.id),
        ["a-u1", "a-a1", "a-u2"],
      );
      assert.strictEqual(after.providerThreads.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("honors deletion tombstones, even when the projection row is gone", () => {
    const { projectsDir, workspace, layer } = fixture();
    return Effect.gen(function* () {
      writeTranscript({
        projectsDir,
        sessionId: SESSION_A,
        cwd: workspace,
        messages: baseMessages,
      });
      assert.strictEqual((yield* sync(projectsDir)).counters.created, 1);

      const threadId = ThreadId.make(`claude-import-${SESSION_A}`);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const deletedAt = DateTime.makeUnsafe("2026-09-02T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("test:delete"),
            type: "thread.deleted",
            threadId,
            occurredAt: deletedAt,
            payload: { ...thread, deletedAt },
          },
        ],
      });
      const afterDelete = yield* sync(projectsDir);
      assert.strictEqual(afterDelete.counters.skippedDeleted, 1, afterDelete.lines.join("\n"));

      // A purged/rebuilt projection must not resurrect it: the event log is the tombstone.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      const afterPurge = yield* sync(projectsDir);
      assert.strictEqual(afterPurge.counters.skippedDeleted, 1, afterPurge.lines.join("\n"));
      assert.strictEqual(afterPurge.counters.created, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips sessions owned by another thread (v2 provider thread or v1 cursor)", () => {
    const { projectsDir, workspace, layer } = fixture();
    return Effect.gen(function* () {
      writeTranscript({
        projectsDir,
        sessionId: SESSION_A,
        cwd: workspace,
        messages: baseMessages,
      });
      writeTranscript({
        projectsDir,
        sessionId: SESSION_B,
        cwd: workspace,
        messages: [{ uuid: "b-u1", role: "user", text: "Native T3 session" }],
      });
      const eventSink = yield* EventSink.EventSinkV2;
      const native = yield* createThread({ threadId: "native-thread" });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("test:native-provider-thread"),
            type: "provider-thread.updated",
            threadId: native.id,
            driver: CLAUDE_DRIVER,
            providerInstanceId: CLAUDE_INSTANCE,
            occurredAt: native.createdAt,
            payload: {
              ...importedClaudeProviderThread({
                threadId: native.id,
                sessionId: SESSION_A,
                providerInstanceId: CLAUDE_INSTANCE,
                at: native.createdAt,
              }),
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
            },
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
          last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'legacy-thread', 'claudeAgent', 'claudeAgent', 'claudeAgent', 'full-access', 'stopped',
          '2026-08-01T00:00:00.000Z', ${encodeJson({ resume: SESSION_B, turnCount: 3 })}, NULL
        )
      `;
      const report = yield* sync(projectsDir);
      assert.strictEqual(report.counters.skippedOwned, 2, report.lines.join("\n"));
      assert.include(report.lines.join("\n"), `ownerThreadId=native-thread`);
      assert.include(report.lines.join("\n"), `ownerThreadId=legacy-thread`);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "skips worktree sessions, fork copies, forked threads and unhydrated migrations",
    () => {
      const { projectsDir, workspace, worktreesDir, layer } = fixture();
      return Effect.gen(function* () {
        const worktreeCwd = NodePath.join(worktreesDir, "repo", "t3code-1234");
        NodeFS.mkdirSync(worktreeCwd, { recursive: true });
        writeTranscript({
          projectsDir,
          sessionId: "33333333-3333-4333-8333-333333333333",
          cwd: worktreeCwd,
          messages: [{ uuid: "w-u1", role: "user", text: "inside a T3 worktree" }],
        });
        writeTranscript({
          projectsDir,
          sessionId: SESSION_A,
          cwd: workspace,
          messages: baseMessages,
        });
        const first = yield* sync(projectsDir);
        assert.strictEqual(first.counters.skippedWorktree, 1, first.lines.join("\n"));
        assert.strictEqual(first.counters.created, 1);

        // forkSession copy: same message uuids under a new session id.
        writeTranscript({
          projectsDir,
          sessionId: SESSION_B,
          cwd: workspace,
          messages: [...baseMessages, { uuid: "b-new", role: "user", text: "continued" }],
        });
        const second = yield* sync(projectsDir);
        assert.strictEqual(second.counters.skippedCopy, 1, second.lines.join("\n"));

        // Once T3 has run a turn in the thread, mirroring stops (in-place resume).
        const sql = yield* SqlClient.SqlClient;
        const threadId = `claude-import-${SESSION_A}`;
        yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
          completed_at, payload_json
        ) VALUES (
          'run:1', ${threadId}, 1, 'claudeAgent', NULL, 'completed', '2026-09-03T00:00:00.000Z',
          '2026-09-03T00:01:00.000Z', '{}'
        )
      `;
        writeTranscript({
          projectsDir,
          sessionId: SESSION_A,
          cwd: workspace,
          messages: [...baseMessages, { uuid: "a-t3", role: "user", text: "sent from T3" }],
        });
        const third = yield* sync(projectsDir);
        assert.strictEqual(third.counters.skippedForked, 1, third.lines.join("\n"));
        assert.strictEqual(third.counters.updated, 0);

        // A migrated v1 import whose messages are still hydrating is left alone.
        const pendingSession = "44444444-4444-4444-8444-444444444444";
        yield* createThread({
          threadId: `claude-import-${pendingSession}`,
          historyOrigin: "v1_import",
        });
        yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, transcript_imported_at
        ) VALUES (
          ${`claude-import-${pendingSession}`}, '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', NULL
        )
      `;
        writeTranscript({
          projectsDir,
          sessionId: pendingSession,
          cwd: workspace,
          messages: [{ uuid: "p-u1", role: "user", text: "old import" }],
        });
        const fourth = yield* sync(projectsDir);
        assert.strictEqual(fourth.counters.skippedPendingMigration, 1, fourth.lines.join("\n"));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rebinds a migrated import thread that has no provider thread yet", () => {
    const { projectsDir, workspace, layer } = fixture();
    return Effect.gen(function* () {
      const threadId = ThreadId.make(`claude-import-${SESSION_A}`);
      yield* createThread({ threadId, historyOrigin: "v1_import" });
      const eventSink = yield* EventSink.EventSinkV2;
      // Hydrated v1 messages keep the transcript uuids as ids.
      yield* eventSink.write({
        events: baseMessages.map((message, index) => ({
          id: EventId.make(`test:legacy-message:${index}`),
          type: "message.updated" as const,
          threadId,
          occurredAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
          payload: {
            createdBy: message.role === "user" ? ("user" as const) : ("agent" as const),
            creationSource: "server" as const,
            id: message.uuid as never,
            threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments: [],
            streaming: false,
            createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
            updatedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
          },
        })),
      });
      writeTranscript({
        projectsDir,
        sessionId: SESSION_A,
        cwd: workspace,
        messages: baseMessages,
      });
      const report = yield* sync(projectsDir);
      assert.strictEqual(report.counters.unchanged, 1, report.lines.join("\n"));
      assert.include(report.lines.join("\n"), "resume=rebound");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      assert.strictEqual(
        records.thread.activeProviderThreadId,
        deriveProviderThread({ driver: CLAUDE_DRIVER, nativeThreadId: SESSION_A }),
      );
      assert.isTrue(providerThreadHasImportedNativeHistory(records.providerThreads[0]!));
    }).pipe(Effect.provide(layer));
  });
});
