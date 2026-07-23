import { cn } from "../../lib/utils";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

/** Map a 0–100 load into the app's status tokens: <60 success, 60–85 warning, >85 destructive. */
function loadTone(percent: number): { fill: string; text: string } {
  if (percent > 85) return { fill: "bg-destructive", text: "text-destructive-foreground" };
  if (percent >= 60) return { fill: "bg-warning", text: "text-warning-foreground" };
  return { fill: "bg-success", text: "text-success-foreground" };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

interface MeterRowProps {
  readonly label: string;
  readonly percent: number;
  readonly value: string;
}

function MeterRow({ label, percent, value }: MeterRowProps) {
  const tone = loadTone(percent);
  return (
    <div className="grid grid-cols-[1.75rem_1fr_auto] items-center gap-1.5">
      <span className="text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-700 ease-out", tone.fill)}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className={cn("text-right text-[11px] leading-none tabular-nums", tone.text)}>{value}</span>
    </div>
  );
}

/**
 * Two slim stacked meter bars — CPU on top, MEM below — with a color-ramped
 * fill and a right-aligned tabular value, all on a shared three-column grid so
 * tracks and figures line up. Fills glide on each 5s refresh.
 */
export function VariantBars({ stats }: HostStatsVariantProps) {
  const cpuPercent = clampPercent(stats.cpuPercent);
  const memPercent =
    stats.memTotalBytes > 0 ? clampPercent((stats.memUsedBytes / stats.memTotalBytes) * 100) : 0;

  const cpuValue = `${Math.round(cpuPercent)}%`;
  const memValue = `${formatFooterGigabytes(stats.memUsedBytes)}/${formatFooterGigabytes(stats.memTotalBytes)}G`;
  const detail = hostStatsDetail(stats);

  return (
    <div
      className="flex w-[130px] shrink-0 flex-col justify-center gap-1 whitespace-nowrap px-2"
      title={detail}
      aria-label={detail}
    >
      <MeterRow label="CPU" percent={cpuPercent} value={cpuValue} />
      <MeterRow label="MEM" percent={memPercent} value={memValue} />
    </div>
  );
}
