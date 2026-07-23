import { cn } from "../../lib/utils";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

const SEGMENT_COUNT = 10;
const SEGMENTS = Array.from({ length: SEGMENT_COUNT }, (_, index) => index);

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function loadColor(percent: number): string {
  if (percent > 85) return "bg-destructive";
  if (percent >= 60) return "bg-warning";
  return "bg-success";
}

interface SegmentMeterProps {
  readonly percent: number;
  readonly peakPercent: number;
}

function SegmentMeter({ percent, peakPercent }: SegmentMeterProps) {
  const litCount = Math.ceil((clampPercent(percent) / 100) * SEGMENT_COUNT);
  const peakCount = Math.ceil((clampPercent(peakPercent) / 100) * SEGMENT_COUNT);
  const color = loadColor(percent);

  return (
    <span aria-hidden="true" className="flex min-w-0 gap-px">
      {SEGMENTS.map((index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 min-w-0 flex-1 rounded-[2px] transition-colors duration-700 ease-out md:h-2.5",
            index < litCount ? color : index < peakCount ? "bg-muted-foreground/30" : "bg-muted",
          )}
        />
      ))}
    </span>
  );
}

export function VariantSegments({ stats, history }: HostStatsVariantProps) {
  const detail = hostStatsDetail(stats);
  const cpuPercent = clampPercent(stats.cpuPercent);
  const memoryPercent = clampPercent(
    stats.memTotalBytes > 0 ? (stats.memUsedBytes / stats.memTotalBytes) * 100 : 0,
  );
  const cpuPeak = history.reduce(
    (peak, sample) => Math.max(peak, clampPercent(sample.cpuPercent)),
    cpuPercent,
  );
  const memoryPeak = history.reduce((peak, sample) => {
    const samplePercent =
      sample.memTotalBytes > 0 ? (sample.memUsedBytes / sample.memTotalBytes) * 100 : 0;
    return Math.max(peak, clampPercent(samplePercent));
  }, memoryPercent);

  return (
    <div
      className="grid h-7 w-[150px] shrink-0 grid-cols-[22px_1fr_59px] content-center items-center gap-x-1 whitespace-nowrap rounded-md border border-border/60 bg-muted/25 px-1.5 py-0.5 tabular-nums md:h-full md:w-full md:grid-cols-[28px_1fr_70px] md:gap-x-1.5 md:gap-y-2 md:px-2.5"
      title={detail}
      aria-label={detail}
    >
      <span className="text-[9px] font-semibold tracking-wide text-muted-foreground md:text-[10px]">
        CPU
      </span>
      <SegmentMeter percent={cpuPercent} peakPercent={cpuPeak} />
      <span className="text-right text-[11px] font-semibold leading-none text-foreground md:text-[13px]">
        {cpuPercent.toFixed(1)}%
      </span>

      <span className="text-[9px] font-semibold tracking-wide text-muted-foreground md:text-[10px]">
        MEM
      </span>
      <SegmentMeter percent={memoryPercent} peakPercent={memoryPeak} />
      <span className="text-right text-[11px] font-semibold leading-none text-foreground md:text-[13px]">
        {formatFooterGigabytes(stats.memUsedBytes)}/{formatFooterGigabytes(stats.memTotalBytes)}G
      </span>
    </div>
  );
}
