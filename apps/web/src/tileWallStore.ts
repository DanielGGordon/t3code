import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { MAX_TILE_COLUMNS, MAX_TILE_ROWS, type TileLayoutPreference } from "./lib/tileWall";
import { resolveStorage } from "./lib/storage";

interface TileWallState extends TileLayoutPreference {
  readonly open: boolean;
  /** Tile keys in the order the user dragged them into; threads missing from it follow. */
  readonly order: ReadonlyArray<string>;
  /** Set on first open; only then is the wall worth prefetching at startup. */
  readonly used: boolean;
}

function boundedOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

// Per device: the same wall wants different counts on an ultrawide and a laptop.
export const useTileWallStore = create<TileWallState>()(
  persist<TileWallState, [], [], Omit<TileWallState, "open">>(
    () => ({ open: false, columns: null, rows: null, order: [], used: false }),
    {
      name: "t3code:tile-wall:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ columns, rows, order, used }) => ({ columns, rows, order, used }),
      merge: (persisted, current) => {
        const layout = (persisted ?? {}) as Partial<Omit<TileWallState, "open">>;
        return {
          ...current,
          columns: boundedOrNull(layout.columns, MAX_TILE_COLUMNS),
          rows: boundedOrNull(layout.rows, MAX_TILE_ROWS),
          order: Array.isArray(layout.order)
            ? layout.order.filter((key): key is string => typeof key === "string")
            : [],
          used: layout.used === true,
        };
      },
    },
  ),
);

export function toggleTileWall(): void {
  useTileWallStore.setState((state) => ({ open: !state.open, used: true }));
}

export function closeTileWall(): void {
  useTileWallStore.setState({ open: false });
}

export function setTileWallLayout(layout: Partial<TileLayoutPreference>): void {
  useTileWallStore.setState(layout);
}

export function setTileWallOrder(order: ReadonlyArray<string>): void {
  useTileWallStore.setState({ order });
}
