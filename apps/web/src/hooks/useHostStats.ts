import type { ServerHostStatsResult } from "@t3tools/contracts";
import { useEffect } from "react";

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
