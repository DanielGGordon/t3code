import { cn } from "../../lib/utils";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

const SPARK_WIDTH = 56;
const SPARK_HEIGHT = 20;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Load-ramp color class: <60% success, 60–85% warning, >85% destructive. */
function rampClass(cpuPercent: number): string {
  if (cpuPercent > 85) return "text-destructive";
  if (cpuPercent >= 60) return "text-warning";
  return "text-success";
}

/** Oldest→newest polyline + closed area points for the CPU sparkline. */
function buildSparkPoints(cpuSamples: readonly number[]): { line: string; area: string } {
  const samples = cpuSamples.length >= 2 ? cpuSamples : [cpuSamples[0] ?? 0, cpuSamples[0] ?? 0];
  const step = SPARK_WIDTH / (samples.length - 1);
  const coords = samples.map((cpu, index) => {
    const x = index * step;
    const y = SPARK_HEIGHT - (cpu / 100) * SPARK_HEIGHT;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = coords.join(" ");
  const area = `0,${SPARK_HEIGHT} ${line} ${SPARK_WIDTH},${SPARK_HEIGHT}`;
  return { line, area };
}

// Live CPU sparkline hero readout: a colored trend line for recent load next
// to a bold current-value figure, with memory tucked in small below it.
export function VariantSparkline({ stats, history }: HostStatsVariantProps) {
  const cpuPercent = clampPercent(stats.cpuPercent);
  const cpuSamples = history.map((sample) => clampPercent(sample.cpuPercent));
  const { line, area } = buildSparkPoints(cpuSamples.length > 0 ? cpuSamples : [cpuPercent]);
  const color = rampClass(cpuPercent);
  const detail = hostStatsDetail(stats);
  const cpuLabel = `${cpuPercent.toFixed(1)}%`;
  const memLabel = `${formatFooterGigabytes(stats.memUsedBytes)}/${formatFooterGigabytes(stats.memTotalBytes)}G`;

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border/40 bg-muted/30 px-1.5"
      title={detail}
      aria-label={detail}
    >
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        className={cn("shrink-0 transition-colors duration-500 ease-out", color)}
        aria-hidden="true"
      >
        <polygon points={area} className="fill-current opacity-15" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex flex-col items-start justify-center gap-0.5 leading-none">
        <span className={cn("text-[11px] font-semibold tabular-nums transition-colors duration-500 ease-out", color)}>
          {cpuLabel}
        </span>
        <span className="text-[9px] tabular-nums text-muted-foreground/70">{memLabel}</span>
      </div>
    </div>
  );
}
