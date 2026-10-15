export type LogThrottleDecision =
  | { readonly log: true; readonly suppressed: number }
  | { readonly log: false };

/**
 * Lets a repeated log line through once per key per window. A client retrying a
 * revoked credential can hit the server hundreds of times a minute; logging every
 * attempt floods journald and rotates real evidence out of it. A logged line
 * reports how many repeats of its key were dropped since the previous one.
 *
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
