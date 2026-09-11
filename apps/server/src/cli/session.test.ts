import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import { formatAuditRow, readClaudeResumeTarget, threadLifecycle } from "./session.ts";

const THREAD_ID = ThreadId.make("thread-1");
const SESSION_ID = "9af5bb2c-886f-474a-9caa-af43d15fed38";

function claudeBinding(overrides: Partial<ProviderRuntimeBinding> = {}): ProviderRuntimeBinding {
  return {
    threadId: THREAD_ID,
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    resumeCursor: { threadId: THREAD_ID, resume: SESSION_ID, turnCount: 0 },
    runtimePayload: { cwd: "/home/me/app", model: "claude-fable-5" },
    ...overrides,
  };
}

it("reads the resume target from a Claude binding", () => {
  assert.deepStrictEqual(readClaudeResumeTarget(claudeBinding()), {
    threadId: THREAD_ID,
    sessionId: SESSION_ID,
    cwd: "/home/me/app",
  });
});

it("keeps fork cursors (imported threads) and tolerates a missing cwd", () => {
  const target = readClaudeResumeTarget(
    claudeBinding({
      resumeCursor: { threadId: THREAD_ID, resume: SESSION_ID, forkSession: true },
      runtimePayload: null,
    }),
  );
  assert.deepStrictEqual(target, { threadId: THREAD_ID, sessionId: SESSION_ID, cwd: undefined });
});

it("ignores non-Claude bindings and bindings without a resume id", () => {
  assert.strictEqual(
    readClaudeResumeTarget(claudeBinding({ provider: ProviderDriverKind.make("codex") })),
    undefined,
  );
  assert.strictEqual(readClaudeResumeTarget(claudeBinding({ resumeCursor: null })), undefined);
  assert.strictEqual(
    readClaudeResumeTarget(claudeBinding({ resumeCursor: { threadId: THREAD_ID, turnCount: 2 } })),
    undefined,
  );
  assert.strictEqual(readClaudeResumeTarget(claudeBinding({ resumeCursor: "junk" })), undefined);
});

it("classifies thread lifecycle from the projection", () => {
  const base = { archivedAt: null, deletedAt: null };
  assert.strictEqual(threadLifecycle(undefined), "unknown");
  assert.strictEqual(threadLifecycle(base as never), "active");
  assert.strictEqual(
    threadLifecycle({ ...base, archivedAt: "2026-01-01T00:00:00.000Z" } as never),
    "archived",
  );
  assert.strictEqual(
    threadLifecycle({
      archivedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-02-01T00:00:00.000Z",
    } as never),
    "deleted",
  );
});

it("formats a missing row with the path to restore", () => {
  const line = formatAuditRow({
    threadId: THREAD_ID,
    title: 'Second "Brain"',
    lifecycle: "active",
    sessionId: SESSION_ID,
    cwd: "/home/me/app",
    location: {
      kind: "missing",
      expectedPath: `/home/me/.claude/projects/-home-me-app/${SESSION_ID}.jsonl`,
    },
  });
  assert.strictEqual(
    line,
    `thread=thread-1 lifecycle=active title="Second \\"Brain\\"" session=${SESSION_ID} cwd=/home/me/app expected=/home/me/.claude/projects/-home-me-app/${SESSION_ID}.jsonl`,
  );
});
