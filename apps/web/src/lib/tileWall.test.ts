import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  computeTileGrid,
  orderTileWallThreads,
  resolveTileState,
  selectTileWallThreads,
  tileWallKey,
} from "./tileWall";

const NOW = "2026-11-04T12:00:00.000Z";

function shell(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    environmentId: "env",
    id,
    projectId: "project",
    createdAt: `2026-11-04T10:00:0${id}.000Z`,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("selectTileWallThreads", () => {
  it("keeps unsettled threads in creation order and drops everything the sidebar tucks away", () => {
    const threads = [
      shell("5"),
      shell("1", { settledOverride: "settled" }),
      shell("2", { archivedAt: NOW }),
      shell("3", { snoozedUntil: "2026-11-05T12:00:00.000Z" }),
      shell("4", {
        lineage: {
          parentThreadId: "5",
          relationshipToParent: null,
          rootThreadId: "5",
          sideChat: true,
        } as never,
      }),
      shell("6", { settledOverride: "active" }),
      shell("7", { snoozedUntil: "2026-11-03T12:00:00.000Z" }),
    ];
    const selected = selectTileWallThreads({ threads, delegatedUnderParent: new Set(), now: NOW });
    expect(selected.map((thread) => thread.id)).toEqual(["5", "6", "7"]);
  });
});

describe("orderTileWallThreads", () => {
  it("puts dragged tiles first in their saved order and leaves new threads after them", () => {
    const threads = [shell("1"), shell("2"), shell("3"), shell("4")];
    const saved = [tileWallKey(threads[2]!), tileWallKey(threads[0]!), "env:gone"];
    expect(orderTileWallThreads(threads, saved).map((thread) => thread.id)).toEqual([
      "3",
      "1",
      "2",
      "4",
    ]);
  });
});

describe("computeTileGrid", () => {
  it.each([
    { count: 1, columns: 1, rows: 1 },
    { count: 3, columns: 3, rows: 1 },
    { count: 8, columns: 4, rows: 2 },
    { count: 12, columns: 6, rows: 2 },
  ])("lays $count tiles out in $columns x $rows on a 3440x1440 screen", (expected) => {
    expect(computeTileGrid(expected.count, 3440, 1440)).toMatchObject({
      columns: expected.columns,
      visibleRows: expected.rows,
    });
  });

  it("keeps tiles wide enough on a 2560x1440 screen and scrolls past that", () => {
    expect(computeTileGrid(12, 2560, 1400)).toMatchObject({ columns: 4, visibleRows: 3 });
    // 5 columns of 512px is the most that fits, and 3 rows the most that stay 420px tall.
    expect(computeTileGrid(40, 2560, 1400)).toMatchObject({ columns: 5, visibleRows: 3 });
  });

  it("treats a chosen count as a cap that never leaves empty columns", () => {
    expect(computeTileGrid(8, 3440, 1440, { columns: 3, rows: null })).toMatchObject({
      columns: 3,
      visibleRows: 3,
    });
    expect(computeTileGrid(2, 3440, 1440, { columns: 6, rows: 2 })).toMatchObject({
      columns: 2,
      visibleRows: 1,
    });
    expect(computeTileGrid(9, 3440, 1440, { columns: null, rows: 2 })).toMatchObject({
      columns: 5,
      visibleRows: 2,
      minTileHeightPx: 0,
    });
    // More tiles than the chosen grid shows: the rest scroll.
    expect(computeTileGrid(20, 3440, 1440, { columns: 4, rows: 2 })).toMatchObject({
      columns: 4,
      visibleRows: 2,
    });
  });
});

describe("resolveTileState", () => {
  const base = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    pendingBackgroundTasks: [],
    latestRun: { status: "completed" },
    runtime: { status: "idle" },
  };
  it.each([
    { name: "a finished run", overrides: {}, expected: "done" },
    { name: "no run yet", overrides: { latestRun: null }, expected: "idle" },
    { name: "an active run", overrides: { runtime: { status: "running" } }, expected: "running" },
    { name: "a failed run", overrides: { latestRun: { status: "failed" } }, expected: "failed" },
    {
      name: "an approval on a running thread",
      overrides: { runtime: { status: "running" }, hasPendingApprovals: true },
      expected: "waiting",
    },
    { name: "a question", overrides: { hasPendingUserInput: true }, expected: "waiting" },
    {
      name: "a plan ready for review",
      overrides: { interactionMode: "plan", hasActionableProposedPlan: true },
      expected: "waiting",
    },
  ])("reads $name as $expected", ({ overrides, expected }) => {
    expect(resolveTileState({ ...base, ...overrides } as never)).toBe(expected);
  });
});
