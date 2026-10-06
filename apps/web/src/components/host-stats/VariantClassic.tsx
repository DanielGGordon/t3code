import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

// The original plain-text readout: "CPU 12%  MEM 3.2/15.6G".
export function VariantClassic({ stats }: HostStatsVariantProps) {
  const cpuLabel = `${Math.round(stats.cpuPercent)}%`;
  const memLabel = `${formatFooterGigabytes(stats.memUsedBytes)}/${formatFooterGigabytes(stats.memTotalBytes)}G`;
  const detail = hostStatsDetail(stats);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-3xs tabular-nums text-muted-foreground/70"
            aria-label={detail}
          />
        }
      >
        <span>CPU {cpuLabel}</span>
        <span>MEM {memLabel}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{detail}</TooltipPopup>
    </Tooltip>
  );
}
