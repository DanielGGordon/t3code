import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

// Fork: which idle conversations are about to lose their provider prompt cache.
// Claude keeps a conversation's cache for an hour after its last request (the
// subscription TTL); once it lapses the next message re-reads the whole context
// uncached. Codex's idle cache lasts minutes, too short to warn about.
export const PROMPT_CACHE_TTL_MS = 60 * 60_000;
export const CACHE_EXPIRY_BANNER_LEAD_MS = 10 * 60_000;
const CACHED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export interface CacheExpiryBanner {
  /** One banner per idle period: the thread plus the run completion it follows. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly tokens: number;
  readonly expiresAt: string;
}

const timeOf = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** Threads whose cache expires within the lead window right now. */
export function dueCacheExpiryBanners(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nowMs: number;
  readonly minTokens: number;
  readonly driverOf: (thread: EnvironmentThreadShell) => string | undefined;
}): ReadonlyArray<CacheExpiryBanner> {
  const due: Array<CacheExpiryBanner> = [];
  for (const thread of input.threads) {
    if (thread.deletedAt || thread.archivedAt || thread.settledAt) continue;
    if (timeOf(thread.snoozedUntil) > input.nowMs) continue;
    // Keep-alive is pinging this thread, so its cache is not about to lapse. A
    // paused one has run out of pings and gets the banner back.
    const keepAlive = thread.source.cacheKeepAlive ?? null;
    if (keepAlive !== null && keepAlive.pausedAt === null) continue;
    // Null while a run is active (and from servers that predate the field).
    const tokens = thread.idleContextTokens;
    if (tokens == null || tokens < input.minTokens) continue;
    const completedAt = thread.latestRun?.completedAt ?? null;
    const completedMs = timeOf(completedAt);
    if (completedAt === null || !Number.isFinite(completedMs)) continue;
    if (timeOf(thread.latestRun?.requestedAt) > completedMs) continue;
    const expiresMs = completedMs + PROMPT_CACHE_TTL_MS;
    if (input.nowMs < expiresMs - CACHE_EXPIRY_BANNER_LEAD_MS || input.nowMs >= expiresMs) continue;
    const driver = input.driverOf(thread);
    if (driver === undefined || !CACHED_DRIVERS.has(driver)) continue;
    due.push({
      key: `${thread.environmentId}:${thread.id}@${completedAt}`,
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      tokens,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  }
  return due;
}

export function formatContextTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : `${Math.round(tokens / 1000)}k`;
}
