import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import {
  type HeaderClaudeUsage,
  type HeaderCodexUsage,
  type HeaderGeminiUsage,
  selectClaudeUsage,
  selectCodexUsage,
  selectGeminiUsage,
} from "../lib/headerUsageLimits";
import { serverEnvironment } from "../state/server";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * Claude plan, Codex and Gemini (Antigravity) subscription windows for one environment, read from
 * the provider snapshots' `usageLimits` the server already publishes and
 * refreshes. `instanceId` is the instance the thread runs on, so a second
 * subscription shows its own windows. Null for a provider that reports no windows (API key, never
 * probed) — render nothing in that case.
 */
export function useProviderUsage(
  environmentId: EnvironmentId,
  instanceId?: ProviderInstanceId | null,
): {
  readonly claude: HeaderClaudeUsage | null;
  readonly codex: HeaderCodexUsage | null;
  readonly gemini: HeaderGeminiUsage | null;
} {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  return {
    claude: selectClaudeUsage(providers, instanceId),
    codex: selectCodexUsage(providers, instanceId),
    gemini: selectGeminiUsage(providers, instanceId),
  };
}
