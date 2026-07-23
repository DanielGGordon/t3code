import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";
import { cn } from "../../lib/utils";

// Two mini donut gauges (CPU + MEM): muted track circle with a round-capped
// progress arc color-ramped by load, starting at 12 o'clock, with the value
// and a tiny label beside it. Refreshes every 5s; the arc glides via a
// stroke-dashoffset transition.
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function loadColorClass(pct: number): string {
  if (pct >= 85) return "text-destructive";
  if (pct >= 60) return "text-warning";
  return "text-success";
}

interface RingGaugeProps {
  readonly pct: number;
  readonly colorClass: string;
  readonly value: string;
  readonly label: string;
}

function RingGauge({ pct, colorClass, value, label }: RingGaugeProps) {
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
  return (
    <div className="flex items-center gap-1.5">
      <svg width="22" height="22" viewBox="0 0 24 24" className="shrink-0" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-muted"
        />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 12 12)"
          stroke="currentColor"
          className={cn(
            colorClass,
            "transition-[stroke-dashoffset] duration-700 ease-out",
          )}
        />
      </svg>
      <div className="flex flex-col leading-none">
        <span className="text-[11px] font-medium tabular-nums text-foreground">{value}</span>
        <span className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
}

export function VariantRings({ stats }: HostStatsVariantProps) {
  const detail = hostStatsDetail(stats);
  const cpuPct = Math.min(100, Math.max(0, stats.cpuPercent));
  const memPct =
    stats.memTotalBytes > 0
      ? Math.min(100, Math.max(0, (stats.memUsedBytes / stats.memTotalBytes) * 100))
      : 0;

  return (
    <div
      className="flex shrink-0 items-center gap-2 whitespace-nowrap tabular-nums"
      title={detail}
      aria-label={detail}
      role="img"
    >
      <RingGauge
        pct={cpuPct}
        colorClass={loadColorClass(cpuPct)}
        value={`${Math.round(cpuPct)}%`}
        label="CPU"
      />
      <span className="h-3.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
      <RingGauge
        pct={memPct}
        colorClass={loadColorClass(memPct)}
        value={`${formatFooterGigabytes(stats.memUsedBytes)}G`}
        label="MEM"
      />
    </div>
  );
}
