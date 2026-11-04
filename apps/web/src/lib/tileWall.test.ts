import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { computeTileGrid, selectTileWallThreads } from "./tileWall";

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

describe("computeTileGrid", () => {
  it.each([
    { count: 1, columns: 1, rows: 1 },
    { count: 3, columns: 3, rows: 1 },
    { count: 8, columns: 4, rows: 2 },
    { count: 12, columns: 6, rows: 2 },
  ])("lays $count tiles out in $columns x $rows on a 3440x1440 screen", (expected) => {
    expect(computeTileGrid(expected.count, 3440, 1440)).toEqual({
      columns: expected.columns,
      rows: expected.rows,
    });
  });

  it("never drops a tile", () => {
    for (let count = 1; count <= 30; count += 1) {
      const { columns, rows } = computeTileGrid(count, 3440, 1440);
      expect(columns * rows).toBeGreaterThanOrEqual(count);
    }
  });
});
