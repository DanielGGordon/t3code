import type { CodexUsageSnapshot } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import {
  codexUsageStrokeColor,
  formatCodexPercent,
  formatResetIn,
  windowUsedPercent,
} from "~/lib/codexUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Top-bar meter for Codex subscription usage. The headline is the primary
 * (5-hour) window's used percentage; the hover popover breaks out the reset
 * time plus the weekly window. Renders nothing until a primary snapshot with a
 * usable percentage is available.
 */
export function CodexUsageMeter(props: { usage: CodexUsageSnapshot }) {
  const { usage } = props;
  const primaryPercent = windowUsedPercent(usage.primary);
  if (primaryPercent === null) {
    return null;
  }

  const nowMs = Date.now();
  const headline = formatCodexPercent(primaryPercent);
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (primaryPercent / 100) * circumference;
  const strokeColor = codexUsageStrokeColor(primaryPercent);

  const primaryResetIn = formatResetIn(usage.primary?.resetsAt ?? null, nowMs);
  const weeklyPercent = windowUsedPercent(usage.secondary);
  const weeklyResetIn = formatResetIn(usage.secondary?.resetsAt ?? null, nowMs);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={headline ? `Codex usage ${headline} of the 5-hour limit` : "Codex usage"}
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {Math.round(primaryPercent)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="bottom" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Codex usage
            </span>
            {usage.planType ? (
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                {usage.planType}
              </span>
            ) : null}
          </div>
          <div className="whitespace-nowrap text-xs font-medium text-foreground">
            <span>5h window</span>
            <span className="mx-1">⋅</span>
            <span>{headline ?? "—"} used</span>
            {primaryResetIn ? (
              <span className="text-muted-foreground"> · resets in {primaryResetIn}</span>
            ) : null}
          </div>
          {weeklyPercent !== null ? (
            <div className="whitespace-nowrap text-xs text-muted-foreground">
              <span>Weekly</span>
              <span className="mx-1">⋅</span>
              <span>{formatCodexPercent(weeklyPercent) ?? "—"} used</span>
              {weeklyResetIn ? <span> · resets in {weeklyResetIn}</span> : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
