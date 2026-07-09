import type { ClaudeAccountUsage, ClaudeAccountUsageLimit } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { HeaderStatBadge } from "./HeaderStatBadge";

function limitLabel(limit: ClaudeAccountUsageLimit): string {
  switch (limit.kind) {
    case "session":
      return "Session (5h)";
    case "weekly_all":
      return "Weekly · all models";
    case "weekly_scoped":
      return limit.scopeLabel ? `Weekly · ${limit.scopeLabel}` : "Weekly · scoped";
    default:
      return limit.kind;
  }
}

function formatResetTime(resetsAt: string | undefined): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }
  const withinDay = resetDate.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  return resetDate.toLocaleString([], {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function percentToneClass(percent: number): string {
  if (percent >= 90) {
    return "text-destructive";
  }
  if (percent >= 70) {
    return "text-warning-foreground";
  }
  return "";
}

function headlineLimit(usage: ClaudeAccountUsage): ClaudeAccountUsageLimit | null {
  const limits = usage.limits;
  if (limits.length === 0) {
    return null;
  }
  return (
    limits.find((limit) => limit.isActive === true) ??
    limits.reduce((max, limit) => (limit.percent > max.percent ? limit : max))
  );
}

export function ClaudeAccountUsageBadge(props: { usage: ClaudeAccountUsage }) {
  const { usage } = props;
  const headline = headlineLimit(usage);
  if (!headline) {
    return null;
  }

  return (
    <HeaderStatBadge
      ariaLabel={`Claude plan usage ${Math.round(headline.percent)}% (${limitLabel(headline)})`}
      triggerClassName={percentToneClass(headline.percent)}
      trigger={
        <>
          <GaugeIcon className="size-3" />
          <span>Claude {Math.round(headline.percent)}%</span>
        </>
      }
    >
      <div className="space-y-1.5 leading-tight">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Claude plan usage
        </div>
        {usage.limits.map((limit) => {
          const resetTime = formatResetTime(limit.resetsAt);
          return (
            <div
              key={`${limit.kind}:${limit.scopeLabel ?? ""}`}
              className="whitespace-nowrap text-xs text-foreground"
            >
              <span className={cn("font-medium", percentToneClass(limit.percent))}>
                {Math.round(limit.percent)}%
              </span>
              <span className="mx-1">⋅</span>
              <span>{limitLabel(limit)}</span>
              {resetTime ? (
                <span className="text-muted-foreground"> · resets {resetTime}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </HeaderStatBadge>
  );
}
