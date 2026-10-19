import type { HeaderControlVisibility } from "@t3tools/contracts/settings";
import type { Notification } from "@t3tools/contracts";

/**
 * Splits a snapshot into notifications not seen before. The first snapshot
 * after (re)connecting only seeds the seen set, so a page load or reconnect
 * never replays old cards as arrivals. Ids that left the list are forgotten,
 * which lets a re-opened id announce itself again.
 */
export function detectArrivals(
  seen: ReadonlySet<string> | null,
  current: ReadonlyArray<Notification>,
): { readonly arrivals: ReadonlyArray<Notification>; readonly seen: ReadonlySet<string> } {
  const next = new Set(current.map((notification) => notification.id));
  if (seen === null) {
    return { arrivals: [], seen: next };
  }
  return { arrivals: current.filter((notification) => !seen.has(notification.id)), seen: next };
}

/** "auto" shows the bell only while something is open; show/hide are absolute. */
export function resolveNotificationBellVisible(
  visibility: HeaderControlVisibility,
  openCount: number,
): boolean {
  if (visibility === "auto") return openCount > 0;
  return visibility === "show";
}

/** The "More info" link is only rendered for http(s) URLs. */
export function safeHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function formatBellCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}
