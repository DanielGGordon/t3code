import type { ComponentType } from "react";
import type { SidebarHostStatsStyle } from "@t3tools/contracts/settings";

import type { HostStatsVariantProps } from "./types";
import { VariantClassic } from "./VariantClassic";
import { VariantSegments } from "./VariantSegments";

export interface HostStatsVariantEntry {
  /** Human label for the Settings → Features style picker. */
  readonly label: string;
  readonly Component: ComponentType<HostStatsVariantProps>;
}

const CLASSIC: HostStatsVariantEntry = {
  label: "Classic (plain text)",
  Component: VariantClassic,
};
const SEGMENTS: HostStatsVariantEntry = { label: "Segments", Component: VariantSegments };

// "segments" won the PR #39 redesign bake-off. The retired candidate ids stay
// decodable (see SidebarHostStatsStyle in contracts) and render as the winner.
export const HOST_STATS_VARIANTS: Readonly<
  Record<SidebarHostStatsStyle, HostStatsVariantEntry>
> = {
  classic: CLASSIC,
  signature: SEGMENTS,
  bars: SEGMENTS,
  sparkline: SEGMENTS,
  segments: SEGMENTS,
  rings: SEGMENTS,
  equalizer: SEGMENTS,
  badge: SEGMENTS,
};

/** The styles actually offered in the picker (retired ids are hidden). */
export const HOST_STATS_PICKER_STYLES: readonly SidebarHostStatsStyle[] = [
  "segments",
  "classic",
];
