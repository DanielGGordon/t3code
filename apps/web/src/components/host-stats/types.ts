import type { ServerHostStatsSnapshot } from "@t3tools/contracts";

import type { HostStatsSample } from "../../hooks/useHostStats";

/**
 * Props every sidebar-footer host-stats variant receives. `stats` is the
 * latest non-null snapshot; `history` is an oldest→newest rolling window of
 * recent samples (~2 minutes at the 5s poll interval, including `stats`).
 *
 * Layout contract: the variant renders inline at the right edge of the
 * sidebar-footer row, next to the Settings button. It must stay within
 * ~150px wide and ~32px tall so it never stretches the row, and should
 * carry its own `title`/`aria-label` detail text.
 */
export interface HostStatsVariantProps {
  readonly stats: ServerHostStatsSnapshot;
  readonly history: readonly HostStatsSample[];
}

/** Compact "3.2/15.6 GB" style figure for footer host-stats readouts. */
export function formatFooterGigabytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 100) return String(Math.round(gigabytes));
  return gigabytes.toFixed(1);
}

/** Shared hover/aria detail line so every variant reads the same to a screen reader. */
export function hostStatsDetail(stats: ServerHostStatsSnapshot): string {
  const coreLabel = stats.cpuCount === 1 ? "1 core" : `${stats.cpuCount} cores`;
  return `Server load — CPU ${stats.cpuPercent.toFixed(1)}% of ${coreLabel} · memory ${formatFooterGigabytes(stats.memUsedBytes)} of ${formatFooterGigabytes(stats.memTotalBytes)} GB`;
}
