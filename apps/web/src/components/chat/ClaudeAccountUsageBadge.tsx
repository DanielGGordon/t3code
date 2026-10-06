import { GaugeIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { HeaderClaudeUsage, HeaderUsageLimit } from "~/lib/headerUsageLimits";
import { HeaderStatBadge } from "./HeaderStatBadge";

function limitLabel(limit: HeaderUsageLimit): string {
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

function percentTone(percent: number): "default" | "warning" | "critical" {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "default";
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

function headlineLimit(usage: HeaderClaudeUsage): HeaderUsageLimit | null {
  const limits = usage.limits;
  if (limits.length === 0) {
    return null;
  }
  return limits.reduce((max, limit) => (limit.percent > max.percent ? limit : max));
}

export function ClaudeAccountUsageBadge(props: { usage: HeaderClaudeUsage }) {
  const { usage } = props;
  const headline = headlineLimit(usage);
  if (!headline) {
    return null;
  }

  return (
    <HeaderStatBadge
      ariaLabel={`Claude plan usage ${Math.round(headline.percent)}% (${limitLabel(headline)})`}
      tone={percentTone(headline.percent)}
      trigger={
        <>
          <GaugeIcon className="size-3" />
          <span>Claude {Math.round(headline.percent)}%</span>
        </>
      }
    >
      <div className="space-y-1.5 leading-tight">
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
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
