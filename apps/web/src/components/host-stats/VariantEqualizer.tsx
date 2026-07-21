import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

import { cn } from "../../lib/utils";

const MAX_BARS = 24;
const BAR_WIDTH = 2;
const GAP = 1;
const TRACK_WIDTH = MAX_BARS * (BAR_WIDTH + GAP) - GAP;

function clampCpu(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function loadTone(cpu: number): "success" | "warning" | "destructive" {
  if (cpu > 85) return "destructive";
  if (cpu >= 60) return "warning";
  return "success";
}

export function VariantEqualizer({ stats, history }: HostStatsVariantProps) {
  const detail = hostStatsDetail(stats);
  const currentCpu = clampCpu(stats.cpuPercent);
  const currentTone = loadTone(currentCpu);

  const bars =
    history.length > 0
      ? history
      : [
          {
            at: 0,
            cpuPercent: stats.cpuPercent,
            memUsedBytes: stats.memUsedBytes,
            memTotalBytes: stats.memTotalBytes,
          },
        ];

  return (
    <div
      className="flex shrink-0 items-end gap-1.5 whitespace-nowrap pl-1.5"
      title={detail}
      aria-label={detail}
    >
      <div className="flex h-5 items-end gap-px" style={{ width: TRACK_WIDTH }}>
        {Array.from({ length: MAX_BARS }, (_, slot) => {
          const dataIndex = slot - (MAX_BARS - bars.length);
          if (dataIndex < 0) {
            return <div key={slot} className="h-full w-[2px]" />;
          }
          const sample = bars[dataIndex];
          if (!sample) return null;
          const cpu = clampCpu(sample.cpuPercent);
          const tone = loadTone(cpu);
          const opacity = bars.length === 1 ? 1 : 0.35 + (dataIndex / (bars.length - 1)) * 0.65;
          return (
            <div
              key={sample.at}
              className={cn(
                "w-[2px] rounded-[1px] transition-[height,opacity] duration-700 ease-out",
                tone === "success" && "bg-success",
                tone === "warning" && "bg-warning",
                tone === "destructive" && "bg-destructive",
              )}
              style={{ height: `${cpu}%`, opacity }}
            />
          );
        })}
      </div>

      <div className="flex flex-col items-start justify-end leading-none">
        <span
          className={cn(
            "text-[11px] font-medium tabular-nums",
            currentTone === "success" && "text-success",
            currentTone === "warning" && "text-warning",
            currentTone === "destructive" && "text-destructive",
          )}
        >
          {Math.round(currentCpu)}%
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatFooterGigabytes(stats.memUsedBytes)}
          <span className="text-[9px] text-muted-foreground/70">/</span>
          {formatFooterGigabytes(stats.memTotalBytes)}G
        </span>
      </div>
    </div>
  );
}
