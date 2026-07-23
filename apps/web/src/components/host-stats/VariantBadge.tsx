import { cn } from "../../lib/utils";
import { formatFooterGigabytes, hostStatsDetail, type HostStatsVariantProps } from "./types";

export function VariantBadge({ stats, history }: HostStatsVariantProps) {
  void history;
  const detail = hostStatsDetail(stats);

  const cpu = Math.max(0, Math.min(100, stats.cpuPercent));
  const memPercent =
    stats.memTotalBytes > 0 ? (stats.memUsedBytes / stats.memTotalBytes) * 100 : 0;

  const cpuStatus = cpu >= 85 ? "destructive" : cpu >= 60 ? "warning" : "success";
  const memStatus = memPercent >= 85 ? "destructive" : memPercent >= 60 ? "warning" : "success";

  const statusPriority = { destructive: 3, warning: 2, success: 1 };
  const overallStatus =
    statusPriority[cpuStatus] > statusPriority[memStatus] ? cpuStatus : memStatus;

  const containerColorClasses = {
    success: "bg-success/10 border-success/20",
    warning: "bg-warning/10 border-warning/20",
    destructive: "bg-destructive/10 border-destructive/20",
  }[overallStatus];

  const dotColorClasses = {
    success: "bg-success",
    warning: "bg-warning animate-pulse",
    destructive: "bg-destructive animate-pulse",
  }[overallStatus];

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 tabular-nums transition-colors duration-700 ease-out",
        containerColorClasses
      )}
      title={detail}
      aria-label={detail}
    >
      <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColorClasses)} />
      <div className="text-[11px] font-semibold text-foreground">
        <span className="mr-1 text-[10px] font-medium text-muted-foreground">CPU</span>
        {Math.round(cpu)}%
        <span className="mx-1.5 font-normal text-muted-foreground/40">·</span>
        <span className="mr-1 text-[10px] font-medium text-muted-foreground">MEM</span>
        {formatFooterGigabytes(stats.memUsedBytes)}G
      </div>
    </div>
  );
}
