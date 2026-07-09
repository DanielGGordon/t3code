import type { CodexUsageResult } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Codex CLI subscription rate-limit usage, read passively from the primary
 * environment host's `~/.codex` rollout files. Null while loading or whenever
 * no snapshot exists (Codex never ran on the host) — render nothing then.
 * Refreshes on an interval and when the window regains focus; the read is a
 * cheap file scan, no Codex API call.
 */
export function useCodexUsage(): CodexUsageResult {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId !== null ? serverEnvironment.codexUsage({ environmentId, input: {} }) : null,
  );
  const refresh = query.refresh;

  useEffect(() => {
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return query.data;
}
