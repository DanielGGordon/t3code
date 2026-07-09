import type { ClaudeAccountUsage } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Account-level Claude plan usage from the primary environment's host
 * credentials. Null while loading or whenever usage is unavailable (no Claude
 * OAuth credentials on the host, expired token, endpoint failure) — render
 * nothing in that case. Refreshes on an interval and when the window regains
 * focus; the server caches upstream fetches, so refreshes are cheap.
 */
export function useClaudeAccountUsage(): ClaudeAccountUsage | null {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId !== null
      ? serverEnvironment.claudeAccountUsage({ environmentId, input: {} })
      : null,
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
