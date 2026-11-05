import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { MAX_TILE_COLUMNS, MAX_TILE_ROWS, type TileLayoutPreference } from "./lib/tileWall";
import { resolveStorage } from "./lib/storage";

interface TileWallState extends TileLayoutPreference {
  readonly open: boolean;
}

function boundedOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

// Per device: the same wall wants different counts on an ultrawide and a laptop.
export const useTileWallStore = create<TileWallState>()(
  persist<TileWallState, [], [], TileLayoutPreference>(
    () => ({ open: false, columns: null, rows: null }),
    {
      name: "t3code:tile-wall:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ columns, rows }) => ({ columns, rows }),
      merge: (persisted, current) => {
        const layout = (persisted ?? {}) as Partial<TileLayoutPreference>;
        return {
          ...current,
          columns: boundedOrNull(layout.columns, MAX_TILE_COLUMNS),
          rows: boundedOrNull(layout.rows, MAX_TILE_ROWS),
        };
      },
    },
  ),
);

export function toggleTileWall(): void {
  useTileWallStore.setState((state) => ({ open: !state.open }));
}

export function closeTileWall(): void {
  useTileWallStore.setState({ open: false });
}

export function setTileWallLayout(layout: Partial<TileLayoutPreference>): void {
  useTileWallStore.setState(layout);
}
