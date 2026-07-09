import type { CodexUsageWindow } from "@t3tools/contracts";

// Format a 0–100 usage percentage the same way the context-window meter does:
// one decimal below 10%, whole numbers above.
export function formatCodexPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped < 10) {
    return `${clamped.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(clamped)}%`;
}

// Human-readable "time until reset" from a Unix epoch-seconds timestamp.
export function formatResetIn(
  resetsAt: number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)) {
    return null;
  }
  const deltaMs = resetsAt * 1000 - nowMs;
  if (deltaMs <= 0) {
    return "now";
  }
  const totalMinutes = Math.round(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

// Color thresholds for the gauge as the window approaches its cap.
export function codexUsageStrokeColor(usedPercent: number): string {
  if (usedPercent >= 90) {
    return "var(--color-red-500, #ef4444)";
  }
  if (usedPercent >= 70) {
    return "var(--color-amber-500, #f59e0b)";
  }
  return "var(--color-muted-foreground)";
}

export function windowUsedPercent(window: CodexUsageWindow | null): number | null {
  if (window === null || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, window.usedPercent));
}
