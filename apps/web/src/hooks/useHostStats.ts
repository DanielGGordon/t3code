import type { ServerHostStatsResult, ServerHostStatsSnapshot } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Whole-host CPU/memory usage of the primary environment's server — ambient
 * telemetry for watching how the T3 box handles load while agents run. Null
 * while loading or when the host stats cannot be read; render nothing then.
 * Polls on a short interval, but only while `enabled`, so the readout costs
 * nothing when the sidebar toggle is off.
 */
export function useHostStats(enabled: boolean): ServerHostStatsResult {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    enabled && environmentId !== null
      ? serverEnvironment.hostStats({ environmentId, input: {} })
      : null,
  );
  const refresh = query.refresh;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, refresh]);

  return query.data;
}

/** One retained host-stats sample; `at` is the client receive time (ms epoch). */
export interface HostStatsSample {
  readonly at: number;
  readonly cpuPercent: number;
  readonly memUsedBytes: number;
  readonly memTotalBytes: number;
}

/** ~2 minutes of history at the 5s poll interval. */
const HISTORY_LIMIT = 24;

export interface HostStatsWithHistory {
  readonly stats: ServerHostStatsSnapshot | null;
  /** Oldest→newest rolling window of recent samples, including `stats`. */
  readonly history: readonly HostStatsSample[];
}

// Module-level so the window survives sidebar unmounts (e.g. visiting the
// Settings page and coming back) — only an explicit disable clears it.
let cachedHistory: readonly HostStatsSample[] = [];

/**
 * `useHostStats` plus a client-side rolling window of recent samples so
 * richer readouts (sparklines, trend meters) have something to draw. The
 * history resets when the readout is disabled.
 */
export function useHostStatsWithHistory(enabled: boolean): HostStatsWithHistory {
  const stats = useHostStats(enabled);
  const [history, setHistory] = useState<readonly HostStatsSample[]>(cachedHistory);
  const lastSampleRef = useRef<ServerHostStatsSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      lastSampleRef.current = null;
      cachedHistory = [];
      setHistory([]);
      return;
    }
    if (stats === null || stats === lastSampleRef.current) {
      return;
    }
    lastSampleRef.current = stats;
    const sample: HostStatsSample = {
      at: Date.now(),
      cpuPercent: stats.cpuPercent,
      memUsedBytes: stats.memUsedBytes,
      memTotalBytes: stats.memTotalBytes,
    };
    cachedHistory = [...cachedHistory.slice(-(HISTORY_LIMIT - 1)), sample];
    setHistory(cachedHistory);
  }, [enabled, stats]);

  return { stats, history };
}
