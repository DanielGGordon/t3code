import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  claudeTranscriptRelativePath,
  describeMissingResumeTranscript,
  encodeClaudeProjectDirName,
  readMissingResumeSessionId,
} from "./claudeSessionTranscript.ts";

const SESSION_ID = "9af5bb2c-886f-474a-9caa-af43d15fed38";

it("encodes a working directory the way Claude Code names project folders", () => {
  assert.strictEqual(
    encodeClaudeProjectDirName("/home/dgordon/projects/voice-ai-integration"),
    "-home-dgordon-projects-voice-ai-integration",
  );
  assert.strictEqual(encodeClaudeProjectDirName("/tmp/a.b_c d"), "-tmp-a-b-c-d");
  assert.strictEqual(
    claudeTranscriptRelativePath("/home/me/app", SESSION_ID),
    `-home-me-app/${SESSION_ID}.jsonl`,
  );
});

it("recognises the CLI's missing-transcript resume failure", () => {
  assert.strictEqual(
    readMissingResumeSessionId(`No conversation found with session ID: ${SESSION_ID}`),
    SESSION_ID,
  );
  assert.strictEqual(
    readMissingResumeSessionId(
      `Error: No conversation found with session ID ${SESSION_ID.toUpperCase()}`,
    ),
    SESSION_ID,
  );
  assert.strictEqual(readMissingResumeSessionId("Error: Request was aborted."), undefined);
  assert.strictEqual(
    readMissingResumeSessionId("No conversation found with session ID: nope"),
    undefined,
  );
  assert.strictEqual(readMissingResumeSessionId(undefined), undefined);
});

it("explains the missing transcript with the expected path and the explicit reset command", () => {
  const threadId = ThreadId.make("thread-1");
  const described = describeMissingResumeTranscript({
    threadId,
    sessionId: SESSION_ID,
    cwd: "/home/dgordon/projects/voice-ai-integration",
  });
  assert.include(
    described.message,
    `~/.claude/projects/-home-dgordon-projects-voice-ai-integration/${SESSION_ID}.jsonl`,
  );
  assert.include(described.message, "t3 session reset thread-1");
  assert.deepStrictEqual(described.detail, {
    reason: "resume_transcript_missing",
    sessionId: SESSION_ID,
    expectedTranscriptPath: `~/.claude/projects/-home-dgordon-projects-voice-ai-integration/${SESSION_ID}.jsonl`,
  });

  const withoutCwd = describeMissingResumeTranscript({
    threadId,
    sessionId: SESSION_ID,
    cwd: undefined,
  });
  assert.include(withoutCwd.message, "expected under ~/.claude/projects");
  assert.strictEqual(withoutCwd.detail.expectedTranscriptPath, undefined);
});
