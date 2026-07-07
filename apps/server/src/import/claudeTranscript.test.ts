import { describe, expect, it } from "vite-plus/test";

import {
  parseClaudeTranscript,
  parseClaudeTranscriptWithStats,
  type ParsedClaudeMessage,
} from "./claudeTranscript.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/home/dgordon/projects/meta/t3code";
const GIT_BRANCH = "main";

const env = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  sessionId: SESSION_ID,
  cwd: CWD,
  gitBranch: GIT_BRANCH,
  version: "1.0.0",
  isSidechain: false,
  ...overrides,
});

// Build a synthetic transcript exercising every case described in the spec.
const FIXTURE_LINES: Array<Record<string, unknown>> = [
  // typed user line (string content)
  env({
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    timestamp: "2026-06-07T22:37:27.235Z",
    message: { role: "user", content: "Hello, please refactor the parser." },
  }),
  // ai-title sidecar line (no uuid/envelope)
  {
    type: "ai-title",
    sessionId: SESSION_ID,
    title: "Refactor the transcript parser",
  },
  // assistant text line
  env({
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    timestamp: "2026-06-07T22:37:30.000Z",
    message: {
      role: "assistant",
      id: "msg_abc",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "Sure, " }],
    },
  }),
  // SECOND assistant line, same message.id, more text (must NOT dedupe)
  env({
    type: "assistant",
    uuid: "a-2",
    parentUuid: "a-1",
    timestamp: "2026-06-07T22:37:31.000Z",
    message: {
      role: "assistant",
      id: "msg_abc",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "let me start." }],
    },
  }),
  // assistant tool_use-only line (must be skipped -> no empty message)
  env({
    type: "assistant",
    uuid: "a-3",
    parentUuid: "a-2",
    timestamp: "2026-06-07T22:37:32.000Z",
    message: {
      role: "assistant",
      id: "msg_def",
      model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
    },
  }),
  // user tool_result line (array content -> must be skipped)
  env({
    type: "user",
    uuid: "u-2",
    parentUuid: "a-3",
    timestamp: "2026-06-07T22:37:33.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }],
    },
  }),
  // isMeta:true user line (injected system-reminder -> must be filtered)
  env({
    type: "user",
    uuid: "u-3",
    parentUuid: "u-2",
    isMeta: true,
    timestamp: "2026-06-07T22:37:34.000Z",
    message: { role: "user", content: "<system-reminder>do not do X</system-reminder>" },
  }),
  // file-history-snapshot line (must be ignored)
  {
    type: "file-history-snapshot",
    sessionId: SESSION_ID,
    messageId: "snap-1",
    snapshot: { trackedFileBackups: {} },
  },
  // final real assistant text line (to verify endedAt advances)
  env({
    type: "assistant",
    uuid: "a-4",
    parentUuid: "u-3",
    timestamp: "2026-06-07T22:37:40.500Z",
    message: {
      role: "assistant",
      id: "msg_ghi",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "Done." }],
    },
  }),
];

const FIXTURE = FIXTURE_LINES.map((l) => JSON.stringify(l)).join("\n");

describe("parseClaudeTranscript", () => {
  it("extracts minimal session metadata and ordered text messages", () => {
    const session = parseClaudeTranscript(FIXTURE);

    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.cwd).toBe(CWD);
    expect(session.gitBranch).toBe(GIT_BRANCH);
    expect(session.title).toBe("Refactor the transcript parser");
    expect(session.startedAt).toBe("2026-06-07T22:37:27.235Z");
    expect(session.endedAt).toBe("2026-06-07T22:37:40.500Z");

    const expected: ParsedClaudeMessage[] = [
      {
        uuid: "u-1",
        role: "user",
        text: "Hello, please refactor the parser.",
        timestamp: "2026-06-07T22:37:27.235Z",
      },
      {
        uuid: "a-1",
        role: "assistant",
        text: "Sure, ",
        timestamp: "2026-06-07T22:37:30.000Z",
      },
      {
        uuid: "a-2",
        role: "assistant",
        text: "let me start.",
        timestamp: "2026-06-07T22:37:31.000Z",
      },
      {
        uuid: "a-4",
        role: "assistant",
        text: "Done.",
        timestamp: "2026-06-07T22:37:40.500Z",
      },
    ];
    expect(session.messages).toEqual(expected);
  });

  it("does NOT dedupe assistant lines that share a message.id", () => {
    const session = parseClaudeTranscript(FIXTURE);
    const splitTurn = session.messages.filter((m) => m.uuid === "a-1" || m.uuid === "a-2");
    expect(splitTurn.map((m) => m.text)).toEqual(["Sure, ", "let me start."]);
  });

  it("skips tool_use-only assistant lines and tool_result user lines", () => {
    const session = parseClaudeTranscript(FIXTURE);
    const uuids = session.messages.map((m) => m.uuid);
    expect(uuids).not.toContain("a-3"); // tool_use-only
    expect(uuids).not.toContain("u-2"); // tool_result array content
  });

  it("filters out isMeta user lines and ignores non-conversation types", () => {
    const session = parseClaudeTranscript(FIXTURE);
    const uuids = session.messages.map((m) => m.uuid);
    expect(uuids).not.toContain("u-3"); // isMeta
    expect(session.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("falls back to custom-title then first user prompt for the title", () => {
    const noAiTitle = FIXTURE_LINES.filter((l) => l.type !== "ai-title");

    const withCustom = [
      { type: "custom-title", sessionId: SESSION_ID, title: "My custom title" },
      ...noAiTitle,
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseClaudeTranscript(withCustom).title).toBe("My custom title");

    const onlyPrompt = noAiTitle.map((l) => JSON.stringify(l)).join("\n");
    expect(parseClaudeTranscript(onlyPrompt).title).toBe("Hello, please refactor the parser.");
  });

  it("truncates a long first-user-prompt title to ~80 chars", () => {
    const longPrompt = "x".repeat(200);
    const line = JSON.stringify(
      env({
        type: "user",
        uuid: "u-long",
        parentUuid: null,
        timestamp: "2026-06-07T22:37:27.235Z",
        message: { role: "user", content: longPrompt },
      }),
    );
    const session = parseClaudeTranscript(line);
    expect(session.title).not.toBeNull();
    expect(session.title!.length).toBeLessThanOrEqual(80);
  });

  it("uses sessionIdFromFilename only as a fallback", () => {
    const fromFilename = parseClaudeTranscript("", { sessionIdFromFilename: "fallback-id" });
    expect(fromFilename.sessionId).toBe("fallback-id");

    // A real sessionId on a line takes precedence over the filename fallback.
    const session = parseClaudeTranscript(FIXTURE, { sessionIdFromFilename: "fallback-id" });
    expect(session.sessionId).toBe(SESSION_ID);
  });

  it("skips malformed lines and counts them instead of throwing", () => {
    const content = ["{ not valid json", "[1,2,3]", FIXTURE].join("\n");
    const { session, malformedLineCount } = parseClaudeTranscriptWithStats(content);
    expect(malformedLineCount).toBe(2); // bad json + non-record array
    expect(session.messages.length).toBe(4);
  });

  it("returns an empty session for empty input", () => {
    const session = parseClaudeTranscript("");
    expect(session).toEqual({
      sessionId: "",
      cwd: null,
      gitBranch: null,
      title: null,
      startedAt: null,
      endedAt: null,
      messages: [],
    });
  });
});
