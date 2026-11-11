export type LogThrottleDecision =
  | { readonly log: true; readonly suppressed: number }
  | { readonly log: false };

/**
 * Lets a repeated log line through once per key per window, so a client retrying a revoked
 * credential cannot flood journald. A logged line reports how many repeats were dropped.
 * Holds at most `maxKeys` keys, so a flood of distinct keys stays bounded too.
 */
export function makeLogThrottle(options: { readonly windowMs: number; readonly maxKeys: number }) {
  const entries = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  return (key: string, now: number): LogThrottleDecision => {
    const entry = entries.get(key);
    if (entry !== undefined && now - entry.lastLoggedAt < options.windowMs) {
      entry.suppressed += 1;
      return { log: false };
    }
    if (entry === undefined && entries.size >= options.maxKeys) {
      for (const [staleKey, stale] of entries) {
        if (now - stale.lastLoggedAt >= options.windowMs) entries.delete(staleKey);
      }
      if (entries.size >= options.maxKeys) {
        return { log: false };
      }
    }
    entries.set(key, { lastLoggedAt: now, suppressed: 0 });
    return { log: true, suppressed: entry?.suppressed ?? 0 };
  };
}
