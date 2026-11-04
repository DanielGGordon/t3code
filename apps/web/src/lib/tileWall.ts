import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";

/** Chat tiles read best a little taller than wide; the grid is chosen to land near this. */
const TARGET_TILE_ASPECT = 0.9;
/** The wall scrolls rather than let a tile get shorter than this. */
export const MIN_TILE_HEIGHT_PX = 420;

/**
 * Every thread the sidebar would not tuck away: not archived, settled, snoozed or shown under a
 * parent. Ordered by creation so tiles keep their place while their threads change.
 */
export function selectTileWallThreads(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly now?: string;
}): ReadonlyArray<EnvironmentThreadShell> {
  const now = input.now ?? new Date().toISOString();
  return filterSidebarV2VisibleThreads(input.threads, null, input.delegatedUnderParent)
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.settledOverride !== "settled" &&
        !effectiveSnoozed(thread, { now }),
    )
    .toSorted(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        scopedThreadKey(scopeThreadRef(a.environmentId, a.id)).localeCompare(
          scopedThreadKey(scopeThreadRef(b.environmentId, b.id)),
        ),
    );
}

/**
 * Columns and rows for `count` tiles in a `width` x `height` box: the fewest empty cells first,
 * then the tile shape closest to `TARGET_TILE_ASPECT`. Rows past what fits at the minimum tile
 * height are fine; the wall scrolls.
 */
export function computeTileGrid(
  count: number,
  width: number,
  height: number,
): { readonly columns: number; readonly rows: number } {
  if (count <= 1 || width <= 0 || height <= 0) return { columns: 1, rows: 1 };
  let best = { columns: count, rows: 1 };
  let bestScore = Number.POSITIVE_INFINITY;
  for (let rows = 1; rows <= count; rows += 1) {
    const columns = Math.ceil(count / rows);
    // A trailing row that holds a single tile wastes more than rebalancing would.
    if (rows > 1 && (rows - 1) * columns >= count) continue;
    const tileHeight = height / rows;
    if (tileHeight < MIN_TILE_HEIGHT_PX && rows > 1) continue;
    const aspect = width / columns / tileHeight;
    const emptyCells = columns * rows - count;
    const score = Math.abs(Math.log(aspect / TARGET_TILE_ASPECT)) + emptyCells * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = { columns, rows };
    }
  }
  return best;
}
