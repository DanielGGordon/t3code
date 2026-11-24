import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ParsedClaudeMessage, ParsedClaudeSession } from "./claudeTranscript.ts";
import {
  buildOwnedSessionIdMap,
  detectForkCopy,
  isRalphSession,
  planExternalAppend,
  planThreadSync,
  RUN_WINDOW_TRAILING_SLACK_MS,
  type RunWindowView,
} from "./syncPlan.ts";

const message = (
  uuid: string,
  role: "user" | "assistant" = "user",
  text = `text-${uuid}`,
  timestamp = "2026-07-01T00:00:00.000Z",
): ParsedClaudeMessage => ({
  uuid,
  role,
  text,
  timestamp,
});

const START_MS = Date.parse("2026-07-01T00:00:00.000Z");
function at(seconds: number): string;
function at(seconds: number, unit: "ms"): number;
function at(seconds: number, unit?: "ms"): string | number {
  const ms = START_MS + seconds * 1000;
  return unit === "ms" ? ms : DateTime.formatIso(DateTime.makeUnsafe(ms));
}
const run = (fromSeconds: number, toSeconds: number): RunWindowView => ({
  requestedAtMs: at(fromSeconds, "ms"),
  completedAtMs: at(toSeconds, "ms"),
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
        runs: [],
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
        runs: [],
        messages: [imported("u-1"), imported("a-1")],
      },
    });
    expect(plan.kind).toBe("unchanged");
  });

  it("appends only the lines another client wrote between T3's runs", () => {
    const s = session([
      message("u-1", "user", "imported", at(0)),
      message("t3-u", "user", "asked in T3", at(10)),
      message("t3-a", "assistant", "answered in T3", at(20)),
      message("cli-u", "user", "asked in the CLI", at(40)),
      message("cli-a", "assistant", "answered in the CLI", at(50)),
    ]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        runs: [run(5, 30)],
        messages: [imported("u-1")],
      },
    });
    expect(plan).toMatchObject({ kind: "append" });
    if (plan.kind === "append") {
      expect(plan.newMessages.map((m) => m.uuid)).toEqual(["cli-u", "cli-a"]);
    }
  });

  it("skips a thread with a turn-bound message", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        runs: [],
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
        runs: [],
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
        runs: [],
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("skips (tombstone) when the projection row is gone but the thread stream ever existed", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: null,
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("still creates when the thread stream never existed", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: null,
      threadStreamEverExisted: false,
    });
    expect(plan.kind).toBe("create");
  });

  it("tombstone flag does not disturb incremental sync of a live thread", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        runs: [],
        messages: [imported("u-1")],
      },
      // A live imported thread's stream trivially exists in the event log.
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("append");
  });

  it("skips a soft-deleted thread even without the tombstone flag", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: "2026-07-02T00:00:00.000Z",
        runs: [],
        messages: [imported("u-1")],
      },
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("plans nothing while a T3 run is in flight", () => {
    const s = session([
      message("u-1", "user", "imported", at(0)),
      message("u-2", "user", "x", at(40)),
    ]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        runs: [run(5, 30), { requestedAtMs: at(35, "ms"), completedAtMs: null }],
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });
});

describe("planExternalAppend", () => {
  const plan = (messages: ParsedClaudeMessage[], runs: ReadonlyArray<RunWindowView>) =>
    planExternalAppend({ session: session(messages), existingMessageIds: new Set(), runs });
  const appended = (result: ReturnType<typeof plan>) =>
    result.kind === "append" ? result.newMessages.map((m) => m.uuid) : [];

  it("keeps lines Claude stamps just after T3 records the run complete", () => {
    const justAfter = DateTime.formatIso(
      DateTime.makeUnsafe(at(30, "ms") + RUN_WINDOW_TRAILING_SLACK_MS - 1),
    );
    expect(appended(plan([message("late", "assistant", "x", justAfter)], [run(5, 30)]))).toEqual(
      [],
    );
  });

  it("never treats what T3's own process wrote between runs as another client's", () => {
    const result = plan(
      [
        message("notify", "user", "<task-notification>\n<task-id>b1</task-id>", at(40)),
        message("reply", "assistant", "The build finished.", at(41)),
        { ...message("wakeup", "assistant", "Heartbeat check", at(42)), entrypoint: "t3-code" },
        { ...message("cli-u", "user", "now me", at(50)), entrypoint: "cli" },
        message("cli-a", "assistant", "hi", at(51)),
      ],
      [run(5, 30)],
    );
    expect(appended(result)).toEqual(["cli-u", "cli-a"]);
  });

  it("ignores history older than the thread's first run, such as a fork's copied lines", () => {
    const result = plan(
      [message("copied", "user", "from the parent", at(0)), message("cli", "user", "new", at(40))],
      [run(5, 30)],
    );
    expect(appended(result)).toEqual(["cli"]);
  });

  it("skips messages already on the thread and lines without a readable timestamp", () => {
    const result = planExternalAppend({
      session: session([message("known", "user", "x", at(40)), message("bad", "user", "x", "?")]),
      existingMessageIds: new Set(["known"]),
      runs: [run(5, 30)],
    });
    expect(result.kind).toBe("unchanged");
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

describe("buildOwnedSessionIdMap", () => {
  const SID = "11111111-2222-4333-8444-555555555555";
  const FORK_SID = "99999999-8888-4777-8666-555555555555";

  it("marks a session owned when a native thread's cursor points at it", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: "f60fe000-c2c7-447a-92de-61e0c372208b", resumeSessionId: SID },
    ]);
    expect(owned.get(SID)).toBe("f60fe000-c2c7-447a-92de-61e0c372208b");
  });

  it("does not mark a session owned by its own import mirror thread", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: `claude-import-${SID}`, resumeSessionId: SID },
    ]);
    expect(owned.has(SID)).toBe(false);
  });

  it("marks a forkSession target owned by the continued import thread", () => {
    // Continuing claude-import-<SID> forked to FORK_SID; the fork transcript
    // must not be imported as its own thread.
    const owned = buildOwnedSessionIdMap([
      { threadId: `claude-import-${SID}`, resumeSessionId: FORK_SID },
    ]);
    expect(owned.has(SID)).toBe(false);
    expect(owned.get(FORK_SID)).toBe(`claude-import-${SID}`);
  });

  it("ignores bindings without a resume session id", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: "some-thread", resumeSessionId: null },
      { threadId: "other-thread", resumeSessionId: "  " },
    ]);
    expect(owned.size).toBe(0);
  });
});

describe("detectForkCopy", () => {
  const msgs = (uuids: string[]) => uuids.map((uuid) => ({ uuid }));
  const index = (entries: Array<[string, string]>) => new Map(entries);

  it("flags a transcript whose messages all belong to another thread", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-original"],
        ["m-2", "claude-import-original"],
        ["m-3", "claude-import-original"],
      ]),
    });
    expect(copy).toEqual({ ownerThreadId: "claude-import-original", sharedRatio: 1 });
  });

  it("flags a fork copy with a short new tail (ratio above threshold)", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3", "new-1"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-original"],
        ["m-2", "claude-import-original"],
        ["m-3", "claude-import-original"],
      ]),
    });
    expect(copy?.ownerThreadId).toBe("claude-import-original");
    expect(copy?.sharedRatio).toBe(0.75);
  });

  it("does not flag a long-diverged fork (mostly new content)", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "new-1", "new-2", "new-3", "new-4"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([["m-1", "claude-import-original"]]),
    });
    expect(copy).toBeNull();
  });

  it("ignores messages owned by the transcript's own thread", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2"]),
      threadId: "claude-import-self",
      messageOwnerIndex: index([
        ["m-1", "claude-import-self"],
        ["m-2", "claude-import-self"],
      ]),
    });
    expect(copy).toBeNull();
  });

  it("attributes the copy to the majority owner", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-a"],
        ["m-2", "claude-import-b"],
        ["m-3", "claude-import-b"],
      ]),
    });
    expect(copy?.ownerThreadId).toBe("claude-import-b");
  });

  it("returns null for an empty transcript", () => {
    const copy = detectForkCopy({
      sessionMessages: [],
      threadId: "claude-import-fork",
      messageOwnerIndex: index([]),
    });
    expect(copy).toBeNull();
  });
});
