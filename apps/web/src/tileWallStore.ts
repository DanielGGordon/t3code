import { create } from "zustand";

interface TileWallState {
  readonly open: boolean;
}

export const useTileWallStore = create<TileWallState>(() => ({ open: false }));

export function toggleTileWall(): void {
  useTileWallStore.setState((state) => ({ open: !state.open }));
}

export function closeTileWall(): void {
  useTileWallStore.setState({ open: false });
}
