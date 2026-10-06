import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  formatAuditRow,
  type SessionAuditRow,
  threadLifecycle,
} from "../import/ClaudeResumeBindings.ts";
import { readLegacyCursorSessionId } from "../import/claudeResumeEvents.ts";
import { formatAuditReport } from "./session.ts";

// Audit/reset behaviour against a real database: import/ClaudeResumeBindings.test.ts.

const THREAD_ID = ThreadId.make("thread-1");
const SESSION_ID = "9af5bb2c-886f-474a-9caa-af43d15fed38";

function row(overrides: Partial<SessionAuditRow> = {}): SessionAuditRow {
  return {
    threadId: THREAD_ID,
    title: 'Second "Brain"',
    lifecycle: "active",
    source: "v2",
    sessionId: SESSION_ID,
    cwd: "/home/me/app",
    location: {
      kind: "missing",
      expectedPath: `/home/me/.claude/projects/-home-me-app/${SESSION_ID}.jsonl`,
    },
    ...overrides,
  };
}

it("reads the session id from legacy v1 cursors (imports and native threads)", () => {
  assert.strictEqual(
    readLegacyCursorSessionId(JSON.stringify({ threadId: "t", resume: SESSION_ID, turnCount: 0 })),
    SESSION_ID,
  );
  assert.strictEqual(
    readLegacyCursorSessionId(JSON.stringify({ resume: SESSION_ID, forkSession: true })),
    SESSION_ID,
  );
  assert.strictEqual(
    readLegacyCursorSessionId(JSON.stringify({ sessionId: SESSION_ID })),
    SESSION_ID,
  );
  assert.strictEqual(readLegacyCursorSessionId(JSON.stringify({ threadId: "codex" })), undefined);
  assert.strictEqual(readLegacyCursorSessionId("junk"), undefined);
  assert.strictEqual(readLegacyCursorSessionId(null), undefined);
});

it("classifies thread lifecycle", () => {
  assert.strictEqual(threadLifecycle(undefined), "unknown");
  assert.strictEqual(threadLifecycle({ archivedAt: null, deletedAt: null }), "active");
  assert.strictEqual(threadLifecycle({ archivedAt: "2026-01-01", deletedAt: null }), "archived");
  assert.strictEqual(
    threadLifecycle({ archivedAt: "2026-01-01", deletedAt: "2026-02-01" }),
    "deleted",
  );
});

it("formats a missing row with the path to restore", () => {
  assert.strictEqual(
    formatAuditRow(row()),
    `thread=thread-1 lifecycle=active title="Second \\"Brain\\"" session=${SESSION_ID} binding=v2 cwd=/home/me/app expected=/home/me/.claude/projects/-home-me-app/${SESSION_ID}.jsonl`,
  );
});

it("reports only missing/relocated rows unless --all, and explains the fix", () => {
  const present = row({
    threadId: ThreadId.make("thread-ok"),
    location: { kind: "present", path: "/x.jsonl" },
  });
  const lines = formatAuditReport({
    rows: [row(), present],
    projectsRoot: "/home/me/.claude/projects",
    includeDeleted: false,
    all: false,
  }).join("\n");
  assert.include(lines, "1 transcript present, 0 relocated, 1 missing");
  assert.include(lines, "thread=thread-1 ");
  assert.notInclude(lines, "thread=thread-ok");
  assert.include(lines, "t3 session reset <threadId> --yes");
  const all = formatAuditReport({
    rows: [row(), present],
    projectsRoot: "/home/me/.claude/projects",
    includeDeleted: false,
    all: true,
  }).join("\n");
  assert.include(all, "thread=thread-ok");
});
