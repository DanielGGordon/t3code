// @effect-diagnostics nodeBuiltinImport:off - fixtures create workspace directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { formatAuditReport } from "../cli/session.ts";
import {
  CLAUDE_INSTANCE,
  createThread,
  encodeJson,
  layerV2Database,
  makeTempDir,
  writeTranscript,
} from "./ClaudeImport.testkit.ts";
import * as ClaudeResumeBindings from "./ClaudeResumeBindings.ts";
import { importedClaudeProviderThread } from "./claudeResumeEvents.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const PRESENT_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSING_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGACY_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const layer = ClaudeResumeBindings.layer.pipe(
  Layer.provideMerge(layerV2Database),
  Layer.provideMerge(NodeServices.layer),
);

/** Bind a thread to a native Claude session the way `t3 import sync` does. */
const bindThread = (threadId: string, sessionId: string) =>
  Effect.gen(function* () {
    const thread = yield* createThread({ threadId, worktreePath: null });
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThread = importedClaudeProviderThread({
      threadId: thread.id,
      sessionId,
      providerInstanceId: CLAUDE_INSTANCE,
      at: thread.createdAt,
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`test:bind:${threadId}`),
          type: "provider-thread.updated",
          threadId: thread.id,
          driver: CLAUDE_DRIVER,
          providerInstanceId: CLAUDE_INSTANCE,
          occurredAt: thread.createdAt,
          payload: providerThread,
        },
      ],
    });
    return providerThread;
  });

const insertProject = (projectId: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, 'Fixture', ${workspaceRoot}, NULL, '[]',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL
      )
    `;
  });

const insertLegacyRuntime = (input: {
  readonly threadId: string;
  readonly provider: string;
  readonly cursor: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (
        ${input.threadId}, ${input.provider}, ${input.provider}, ${input.provider}, 'full-access',
        'stopped', '2026-08-01T00:00:00.000Z', ${encodeJson(input.cursor)}, NULL
      )
    `;
  });

describe("ClaudeResumeBindings", () => {
  it.effect("audit lists the thread whose transcript is missing; reset detaches it", () => {
    const root = makeTempDir("claude-audit");
    const projectsDir = NodePath.join(root, "projects");
    const workspace = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(workspace, { recursive: true });
    return Effect.gen(function* () {
      yield* insertProject("project:fixture", workspace);
      yield* bindThread("thread-present", PRESENT_SESSION);
      const missingProviderThread = yield* bindThread("thread-missing", MISSING_SESSION);
      writeTranscript({
        projectsDir,
        sessionId: PRESENT_SESSION,
        cwd: workspace,
        messages: [{ uuid: "m1", role: "user", text: "hi" }],
      });

      const rows = yield* ClaudeResumeBindings.auditClaudeResumeTargets({
        projectsRoot: projectsDir,
        includeDeleted: false,
      });
      const byThread = new Map(rows.map((row) => [row.threadId, row]));
      assert.strictEqual(byThread.get(ThreadId.make("thread-present"))?.location.kind, "present");
      const missing = byThread.get(ThreadId.make("thread-missing"));
      assert.strictEqual(missing?.location.kind, "missing");
      assert.strictEqual(missing?.sessionId, MISSING_SESSION);
      assert.strictEqual(missing?.source, "v2");
      assert.deepStrictEqual(missing?.location, {
        kind: "missing",
        expectedPath: NodePath.join(
          projectsDir,
          workspace.replace(/[^a-zA-Z0-9]/g, "-"),
          `${MISSING_SESSION}.jsonl`,
        ),
      });
      const report = formatAuditReport({
        rows,
        projectsRoot: projectsDir,
        includeDeleted: false,
        all: false,
      }).join("\n");
      assert.include(report, "thread=thread-missing");
      assert.notInclude(report, "thread=thread-present");
      assert.include(report, "1 missing");

      const bindings = yield* ClaudeResumeBindings.ClaudeResumeBindings;
      const dryRun = yield* bindings.reset({
        threadId: ThreadId.make("thread-missing"),
        apply: false,
      });
      assert.isFalse(dryRun.reset);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* projections.getThreadRecords(ThreadId.make("thread-missing"), []);
      assert.strictEqual(before.thread.activeProviderThreadId, missingProviderThread.id);

      const applied = yield* bindings.reset({
        threadId: ThreadId.make("thread-missing"),
        apply: true,
      });
      assert.isTrue(applied.reset);
      const after = yield* projections.getThreadRecords(ThreadId.make("thread-missing"), [
        "providerThreads",
      ]);
      assert.isNull(after.thread.activeProviderThreadId);
      // The old provider thread stays for the record.
      assert.strictEqual(after.providerThreads.length, 1);

      const rowsAfter = yield* ClaudeResumeBindings.auditClaudeResumeTargets({
        projectsRoot: projectsDir,
        includeDeleted: false,
      });
      assert.isUndefined(rowsAfter.find((row) => row.threadId === "thread-missing"));

      const again = yield* bindings.reset({
        threadId: ThreadId.make("thread-missing"),
        apply: true,
      });
      assert.isFalse(again.reset);
      const unknown = yield* Effect.flip(
        bindings.reset({ threadId: ThreadId.make("no-such-thread"), apply: true }),
      );
      assert.include(unknown.message, "was not found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("restores native resume for migrated v1 Claude threads, idempotently", () =>
    Effect.gen(function* () {
      const bindings = yield* ClaudeResumeBindings.ClaudeResumeBindings;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;

      // Eligible: v1 import with a Claude cursor (its transcript is not on this
      // host — restore must still bind it so `t3 session audit` flags it).
      yield* createThread({ threadId: "claude-import-legacy", historyOrigin: "v1_import" });
      yield* insertLegacyRuntime({
        threadId: "claude-import-legacy",
        provider: "claudeAgent",
        cursor: { threadId: "claude-import-legacy", resume: LEGACY_SESSION, forkSession: true },
      });
      // Not eligible: Codex cursor; native (non-migrated) thread; thread with a run.
      yield* createThread({ threadId: "codex-legacy", historyOrigin: "v1_import" });
      yield* insertLegacyRuntime({
        threadId: "codex-legacy",
        provider: "codex",
        cursor: { threadId: "codex-native-thread" },
      });
      yield* createThread({ threadId: "native-thread" });
      yield* insertLegacyRuntime({
        threadId: "native-thread",
        provider: "claudeAgent",
        cursor: { resume: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      });
      yield* createThread({ threadId: "ran-in-v2", historyOrigin: "v1_import" });
      yield* insertLegacyRuntime({
        threadId: "ran-in-v2",
        provider: "claudeAgent",
        cursor: { resume: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
          completed_at, payload_json
        ) VALUES (
          'run:ran-in-v2', 'ran-in-v2', 1, 'claudeAgent', NULL, 'completed',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:01:00.000Z', '{}'
        )
      `;

      const first = yield* bindings.restoreLegacyResume;
      assert.deepStrictEqual(first, { restored: 1, skipped: 0 });
      const records = yield* projections.getThreadRecords(ThreadId.make("claude-import-legacy"), [
        "providerThreads",
      ]);
      const expectedId = deriveProviderThread({
        driver: CLAUDE_DRIVER,
        nativeThreadId: LEGACY_SESSION,
      });
      assert.strictEqual(records.thread.activeProviderThreadId, expectedId);
      assert.strictEqual(records.thread.historyOrigin, "v1_import");
      // The bind does not reorder the sidebar.
      assert.strictEqual(
        DateTime.toEpochMillis(records.thread.updatedAt),
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
      );
      const providerThread = records.providerThreads[0]!;
      assert.strictEqual(providerThread.nativeThreadRef?.nativeId, LEGACY_SESSION);
      assert.isTrue(providerThreadHasImportedNativeHistory(providerThread));

      for (const threadId of ["codex-legacy", "native-thread", "ran-in-v2"]) {
        const other = yield* projections.getThreadRecords(ThreadId.make(threadId), [
          "providerThreads",
        ]);
        assert.isNull(other.thread.activeProviderThreadId, threadId);
        assert.strictEqual(other.providerThreads.length, 0, threadId);
      }

      // Second boot: nothing left to do, nothing written twice.
      const eventCount = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
      `)[0]!.count;
      const second = yield* bindings.restoreLegacyResume;
      assert.deepStrictEqual(second, { restored: 0, skipped: 0 });
      const eventCountAfter = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
      `)[0]!.count;
      assert.strictEqual(eventCountAfter, eventCount);
    }).pipe(Effect.provide(layer)),
  );
});
