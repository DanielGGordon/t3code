import { cn } from "../../lib/utils";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

/**
 * "Signature" — a two-row precision-fader readout.
 *
 * Each metric is a hairline capacity track with a solid status-colored dot
 * riding it, trailing a translucent wake of the same hue, so severity is
 * encoded twice (position + color). A muted tick marks the recent peak from
 * `history`. Figures stay in neutral text tokens — color lives only in the
 * marks — so the widget sits quietly at idle and lights up under load.
 */

type Tone = "success" | "warning" | "destructive";

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function toneFor(percent: number): Tone {
  if (percent > 85) return "destructive";
  if (percent >= 60) return "warning";
  return "success";
}

const WAKE_CLASS: Record<Tone, string> = {
  success: "bg-success/25",
  warning: "bg-warning/30",
  destructive: "bg-destructive/30",
};

const DOT_CLASS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

interface MeterRowProps {
  readonly label: string;
  readonly value: string;
  readonly percent: number;
  readonly peakPercent: number | null;
}

function MeterRow({ label, value, percent, peakPercent }: MeterRowProps) {
  const tone = toneFor(percent);
  // Only draw the peak-hold tick when it sits clear of the dot.
  const showPeak = peakPercent !== null && peakPercent > percent + 3;

  return (
    <>
      <span className="text-[9px] font-medium uppercase leading-none tracking-[0.08em] text-muted-foreground/70">
        {label}
      </span>
      <div className="relative h-[5px] min-w-[24px] self-center">
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted" />
        <div
          className={cn(
            "absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-[width,background-color] duration-700 ease-out",
            WAKE_CLASS[tone],
          )}
          style={{ width: `${percent}%` }}
        />
        {showPeak ? (
          <div
            className="absolute top-1/2 h-[5px] w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/50 transition-[left] duration-700 ease-out"
            style={{ left: `${peakPercent}%` }}
          />
        ) : null}
        <div
          className={cn(
            "absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left,background-color] duration-700 ease-out",
            DOT_CLASS[tone],
          )}
          style={{ left: `${percent}%` }}
        />
      </div>
      <span className="justify-self-end whitespace-nowrap text-[11px] font-medium leading-none tabular-nums text-foreground/90">
        {value}
      </span>
    </>
  );
}

export function VariantSignature({ stats, history }: HostStatsVariantProps) {
  const detail = hostStatsDetail(stats);

  const cpuPercent = clampPercent(stats.cpuPercent);
  const memPercent =
    stats.memTotalBytes > 0 ? clampPercent((stats.memUsedBytes / stats.memTotalBytes) * 100) : 0;

  const hasWindow = history.length > 1;
  const cpuPeak = hasWindow
    ? Math.max(...history.map((sample) => clampPercent(sample.cpuPercent)))
    : null;
  const memPeak = hasWindow
    ? Math.max(
        ...history.map((sample) =>
          sample.memTotalBytes > 0
            ? clampPercent((sample.memUsedBytes / sample.memTotalBytes) * 100)
            : 0,
        ),
      )
    : null;

  return (
    <div
      role="img"
      className="grid w-[148px] shrink-0 grid-cols-[auto_minmax(24px,1fr)_auto] items-center gap-x-1.5 gap-y-1 whitespace-nowrap px-1.5"
      title={detail}
      aria-label={detail}
    >
      <MeterRow
        label="CPU"
        value={`${Math.round(cpuPercent)}%`}
        percent={cpuPercent}
        peakPercent={cpuPeak}
      />
      <MeterRow
        label="MEM"
        value={`${formatFooterGigabytes(stats.memUsedBytes)}/${formatFooterGigabytes(stats.memTotalBytes)}G`}
        percent={memPercent}
        peakPercent={memPeak}
      />
    </div>
  );
}
