import type { ComponentType } from "react";
import type { SidebarHostStatsStyle } from "@t3tools/contracts/settings";

import type { HostStatsVariantProps } from "./types";
import { VariantBadge } from "./VariantBadge";
import { VariantBars } from "./VariantBars";
import { VariantClassic } from "./VariantClassic";
import { VariantEqualizer } from "./VariantEqualizer";
import { VariantRings } from "./VariantRings";
import { VariantSegments } from "./VariantSegments";
import { VariantSignature } from "./VariantSignature";
import { VariantSparkline } from "./VariantSparkline";

export interface HostStatsVariantEntry {
  /** Human label for the Settings → Features style picker. */
  readonly label: string;
  readonly Component: ComponentType<HostStatsVariantProps>;
}

// Redesign candidates for the sidebar server-load readout, selectable from
// Settings → Features → Sidebar → "Server load style".
export const HOST_STATS_VARIANTS: Readonly<
  Record<SidebarHostStatsStyle, HostStatsVariantEntry>
> = {
  classic: { label: "Classic (plain text)", Component: VariantClassic },
  signature: { label: "Signature", Component: VariantSignature },
  bars: { label: "Bars", Component: VariantBars },
  sparkline: { label: "Sparkline", Component: VariantSparkline },
  segments: { label: "Segments", Component: VariantSegments },
  rings: { label: "Rings", Component: VariantRings },
  equalizer: { label: "Equalizer", Component: VariantEqualizer },
  badge: { label: "Badge", Component: VariantBadge },
};
