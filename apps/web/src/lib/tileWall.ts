import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";

/** Chat tiles read best a little taller than wide; the grid is chosen to land near this. */
const TARGET_TILE_ASPECT = 0.9;
/** The wall scrolls rather than let a tile get shorter than this. */
const MIN_TILE_HEIGHT_PX = 420;
/** ...or narrower than this, where the composer toolbar stops fitting. */
const MIN_TILE_WIDTH_PX = 440;
export const TILE_GAP_PX = 6;
export const MAX_TILE_COLUMNS = 8;
export const MAX_TILE_ROWS = 4;

/** `null` lets the wall's size decide; a number is the most that many the wall shows at once. */
export interface TileLayoutPreference {
  readonly columns: number | null;
  readonly rows: number | null;
}

export interface TileGrid {
  readonly columns: number;
  /** Rows on screen at once; tiles past them scroll. */
  readonly visibleRows: number;
  /** A chosen row count sizes tiles exactly, so only an automatic one keeps a floor. */
  readonly minTileHeightPx: number;
}

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

export function tileWallKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Tiles the user has dragged keep their saved order; any thread not in it yet (new, or woken)
 * follows, in the creation order `selectTileWallThreads` already gave.
 */
export function orderTileWallThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  savedOrder: ReadonlyArray<string>,
): ReadonlyArray<EnvironmentThreadShell> {
  const rank = new Map(savedOrder.map((key, index) => [key, index]));
  return threads.toSorted(
    (a, b) =>
      (rank.get(tileWallKey(a)) ?? Number.POSITIVE_INFINITY) -
        (rank.get(tileWallKey(b)) ?? Number.POSITIVE_INFINITY) || 0,
  );
}

/**
 * The grid for `count` tiles in a `width` x `height` box. Automatic picks the fewest empty cells,
 * then the tile shape closest to `TARGET_TILE_ASPECT`, without going under the minimum tile size
 * (past that the wall scrolls). A chosen count caps that axis and never leaves empty columns.
 */
export function computeTileGrid(
  count: number,
  width: number,
  height: number,
  preference: TileLayoutPreference = { columns: null, rows: null },
): TileGrid {
  const minTileHeightPx = preference.rows === null ? MIN_TILE_HEIGHT_PX : 0;
  if (count <= 1 || width <= 0 || height <= 0)
    return { columns: 1, visibleRows: 1, minTileHeightPx };
  const fitsColumns = Math.max(1, Math.floor(width / MIN_TILE_WIDTH_PX));
  const fitsRows = Math.max(1, Math.floor(height / MIN_TILE_HEIGHT_PX));

  if (preference.columns !== null) {
    const columns = Math.min(preference.columns, count);
    const neededRows = Math.ceil(count / columns);
    return {
      columns,
      visibleRows: Math.min(preference.rows ?? fitsRows, neededRows),
      minTileHeightPx,
    };
  }
  if (preference.rows !== null) {
    const rows = Math.min(preference.rows, count);
    const columns = Math.min(Math.ceil(count / rows), fitsColumns);
    return { columns, visibleRows: Math.min(rows, Math.ceil(count / columns)), minTileHeightPx };
  }

  let best: TileGrid | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let rows = 1; rows <= Math.min(count, fitsRows); rows += 1) {
    const columns = Math.ceil(count / rows);
    // A trailing row that holds a single tile wastes more than rebalancing would.
    if (columns > fitsColumns || (rows > 1 && (rows - 1) * columns >= count)) continue;
    const aspect = width / columns / (height / rows);
    const score = Math.abs(Math.log(aspect / TARGET_TILE_ASPECT)) + (columns * rows - count) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = { columns, visibleRows: rows, minTileHeightPx };
    }
  }
  return (
    best ?? {
      columns: fitsColumns,
      visibleRows: Math.min(fitsRows, Math.ceil(count / fitsColumns)),
      minTileHeightPx,
    }
  );
}

export type TileState = "waiting" | "running" | "failed" | "done" | "idle";

/**
 * What a tile's color says, read from the thread alone: unlike the sidebar's status pill it does
 * not fade once the thread has been visited, since every tile on the wall is always in view.
 */
export function resolveTileState(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "pendingBackgroundTasks"
    | "latestRun"
    | "runtime"
  >,
): TileState {
  const active = threadRuntimeIsActive(thread.runtime);
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0 ||
    (!active && thread.interactionMode === "plan" && thread.hasActionableProposedPlan)
  ) {
    return "waiting";
  }
  if (active || backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)) return "running";
  if (thread.latestRun?.status === "failed") return "failed";
  return thread.latestRun === null ? "idle" : "done";
}
