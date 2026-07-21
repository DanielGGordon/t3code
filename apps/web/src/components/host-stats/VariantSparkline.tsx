import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

// Placeholder for the "Sparkline" redesign — replaced by its design agent.
export function VariantSparkline({ stats }: HostStatsVariantProps) {
  const detail = hostStatsDetail(stats);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-[10px] tabular-nums text-muted-foreground/70"
      title={detail}
      aria-label={detail}
    >
      <span>Sparkline {Math.round(stats.cpuPercent)}%</span>
      <span>{formatFooterGigabytes(stats.memUsedBytes)}G</span>
    </div>
  );
}
