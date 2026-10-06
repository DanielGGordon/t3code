import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  type HeaderClaudeUsage,
  type HeaderCodexUsage,
  selectClaudeUsage,
  selectCodexUsage,
} from "../lib/headerUsageLimits";
import { serverEnvironment } from "../state/server";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * Claude plan and Codex subscription windows for one environment, read from
 * the provider snapshots' `usageLimits` the server already publishes and
 * refreshes. Null for a provider that reports no windows (API key, never
 * probed) — render nothing in that case.
 */
export function useProviderUsage(environmentId: EnvironmentId): {
  readonly claude: HeaderClaudeUsage | null;
  readonly codex: HeaderCodexUsage | null;
} {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  return useMemo(
    () => ({ claude: selectClaudeUsage(providers), codex: selectCodexUsage(providers) }),
    [providers],
  );
}
