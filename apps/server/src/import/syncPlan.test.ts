import { describe, expect, it } from "vite-plus/test";

import type { ParsedClaudeMessage, ParsedClaudeSession } from "./claudeTranscript.ts";
import { isRalphSession, planThreadSync } from "./syncPlan.ts";

const message = (
  uuid: string,
  role: "user" | "assistant" = "user",
  text = `text-${uuid}`,
): ParsedClaudeMessage => ({
  uuid,
  role,
  text,
  timestamp: "2026-07-01T00:00:00.000Z",
});

const session = (messages: ParsedClaudeMessage[]): ParsedClaudeSession => ({
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/home/user/project",
  gitBranch: "main",
  title: "Test session",
  startedAt: "2026-07-01T00:00:00.000Z",
  endedAt: "2026-07-01T01:00:00.000Z",
  messages,
});

const imported = (id: string) => ({ id, turnId: null });

describe("planThreadSync", () => {
  it("plans a full create when the thread does not exist", () => {
    const s = session([message("u-1"), message("a-1", "assistant")]);
    const plan = planThreadSync({ session: s, existingThread: null });
    expect(plan.kind).toBe("create");
    if (plan.kind === "create") {
      expect(plan.messages.map((m) => m.uuid)).toEqual(["u-1", "a-1"]);
    }
  });

  it("appends only the messages that are not imported yet, preserving order", () => {
    const s = session([
      message("u-1"),
      message("a-1", "assistant"),
      message("u-2"),
      message("a-2", "assistant"),
    ]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("a-1")],
      },
    });
    expect(plan.kind).toBe("append");
    if (plan.kind === "append") {
      expect(plan.newMessages.map((m) => m.uuid)).toEqual(["u-2", "a-2"]);
    }
  });

  it("is unchanged when every transcript message is already imported (idempotence)", () => {
    const s = session([message("u-1"), message("a-1", "assistant")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("a-1")],
      },
    });
    expect(plan.kind).toBe("unchanged");
  });

  it("skips a thread that has provider turns (continued in T3)", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: true,
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });

  it("skips a thread with a turn-bound message", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), { id: "u-1b", turnId: "turn-1" }],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });

  it("skips a thread containing a message the transcript cannot explain", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("not-in-transcript")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
    if (plan.kind === "skip-forked") {
      expect(plan.reason).toContain("not-in-transcript");
    }
  });

  it("skips a deleted thread", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: "2026-07-02T00:00:00.000Z",
        hasTurns: false,
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("prefers skip-forked over unchanged/append when both would match", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: true,
        messages: [imported("u-1"), imported("u-2")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });
});

describe("isRalphSession", () => {
  it.each([
    "You are the generator agent",
    "You are the evaluator agent",
    "You are the rescue agent",
  ])("detects a first user prompt starting with '%s'", (prefix) => {
    const s = session([
      message("u-1", "user", `${prefix} for iteration 3. Do the thing.`),
      message("a-1", "assistant", "ok"),
    ]);
    expect(isRalphSession(s)).toBe(true);
  });

  it("ignores leading whitespace before the marker", () => {
    const s = session([message("u-1", "user", "\n  You are the generator agent, go.")]);
    expect(isRalphSession(s)).toBe(true);
  });

  it("does not flag normal sessions", () => {
    const s = session([
      message("u-1", "user", "Please refactor the parser."),
      message("a-1", "assistant", "You are the generator agent — just kidding."),
    ]);
    expect(isRalphSession(s)).toBe(false);
  });

  it("only inspects the FIRST user message", () => {
    const s = session([
      message("u-1", "user", "hello"),
      message("u-2", "user", "You are the generator agent"),
    ]);
    expect(isRalphSession(s)).toBe(false);
  });

  it("does not flag sessions without user messages", () => {
    const s = session([message("a-1", "assistant", "You are the generator agent")]);
    expect(isRalphSession(s)).toBe(false);
  });
});
