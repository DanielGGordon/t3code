import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

/**
 * Header-readout view of the subscription windows providers publish on their
 * snapshot (`ServerProvider.usageLimits`). Claude's five-hour / weekly /
 * model-scoped weekly windows and Codex's session / weekly windows are folded
 * into the shapes the header usage stats and badge render.
 */

export interface HeaderUsageLimit {
  readonly kind: "session" | "weekly_all" | "weekly_scoped";
  /** 0-100. */
  readonly percent: number;
  /** ISO timestamp when the window resets. */
  readonly resetsAt?: string;
  /** Model-family name for scoped weeklies. */
  readonly scopeLabel?: string;
}

export interface HeaderClaudeUsage {
  readonly limits: ReadonlyArray<HeaderUsageLimit>;
}

export interface HeaderCodexWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export interface HeaderCodexUsage {
  /** The five-hour (session) window. */
  readonly primary: HeaderCodexWindow | null;
  /** The weekly window. */
  readonly secondary: HeaderCodexWindow | null;
}

export interface HeaderGeminiUsage {
  /** The five-hour (session) window. */
  readonly session: HeaderCodexWindow | null;
  /** The weekly window. */
  readonly weekly: HeaderCodexWindow | null;
}

const SCOPED_LABEL_PREFIX = /^weekly\s*[·:-]\s*/i;

/**
 * Windows for `driver`. When the thread runs on a specific instance of that
 * driver (a second Claude subscription, say) only that instance's windows
 * count; borrowing another account's numbers would show the wrong plan. Any
 * other thread falls back to the first enabled instance that reports windows.
 */
function findUsageWindows(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
  instanceId?: ProviderInstanceId | null,
  now: number = Date.now(),
): ReadonlyArray<ServerProviderUsageWindow> | null {
  const matching = providers.filter((provider) => provider.driver === driver && provider.enabled);
  const own = instanceId ? matching.find((provider) => provider.instanceId === instanceId) : null;
  // A window past its reset time describes the previous period, so its
  // percentage is stale; show nothing until the next reading arrives.
  const live = (provider: ServerProvider): ReadonlyArray<ServerProviderUsageWindow> | null => {
    const windows = provider.usageLimits?.windows?.filter(
      (window) => !window.resetsAt || Date.parse(String(window.resetsAt)) > now,
    );
    return windows && windows.length > 0 ? windows : null;
  };
  if (own) return live(own);
  for (const provider of matching) {
    const windows = live(provider);
    if (windows) return windows;
  }
  return null;
}

function resetsAtField(window: ServerProviderUsageWindow): { resetsAt?: string } {
  return window.resetsAt ? { resetsAt: String(window.resetsAt) } : {};
}

/** Claude plan windows from the first enabled Claude provider that reports any. */
export function selectClaudeUsage(
  providers: ReadonlyArray<ServerProvider>,
  instanceId?: ProviderInstanceId | null,
): HeaderClaudeUsage | null {
  const windows = findUsageWindows(providers, "claudeAgent", instanceId);
  if (windows === null) return null;
  const limits: HeaderUsageLimit[] = [];
  for (const window of windows) {
    if (window.kind === "session") {
      limits.push({ kind: "session", percent: window.usedPercent, ...resetsAtField(window) });
    } else if (window.kind === "weekly") {
      if (window.id === "seven_day") {
        limits.push({ kind: "weekly_all", percent: window.usedPercent, ...resetsAtField(window) });
      } else {
        const scopeLabel = window.label.replace(SCOPED_LABEL_PREFIX, "").trim();
        limits.push({
          kind: "weekly_scoped",
          percent: window.usedPercent,
          ...(scopeLabel ? { scopeLabel } : {}),
          ...resetsAtField(window),
        });
      }
    }
  }
  return limits.length > 0 ? { limits } : null;
}

/** Codex session/weekly windows from the first enabled Codex provider that reports any. */
export function selectCodexUsage(
  providers: ReadonlyArray<ServerProvider>,
  instanceId?: ProviderInstanceId | null,
): HeaderCodexUsage | null {
  const windows = findUsageWindows(providers, "codex", instanceId);
  if (windows === null) return null;
  const toWindow = (window: ServerProviderUsageWindow | undefined): HeaderCodexWindow | null =>
    window ? { usedPercent: window.usedPercent, ...resetsAtField(window) } : null;
  const primary = toWindow(windows.find((window) => window.kind === "session"));
  const secondary = toWindow(windows.find((window) => window.kind === "weekly"));
  return primary || secondary ? { primary, secondary } : null;
}

/**
 * Gemini session/weekly windows from the first enabled Antigravity provider
 * that reports any. Antigravity also reports a shared Claude & GPT allowance;
 * only the Gemini buckets count here. When several Gemini buckets share a
 * kind (Pro and Flash, say) the fullest one wins — it is the one that blocks
 * work first.
 */
export function selectGeminiUsage(
  providers: ReadonlyArray<ServerProvider>,
  instanceId?: ProviderInstanceId | null,
): HeaderGeminiUsage | null {
  const windows = findUsageWindows(providers, "antigravity", instanceId);
  if (windows === null) return null;
  const fullest = (kind: ServerProviderUsageWindow["kind"]): HeaderCodexWindow | null => {
    let best: ServerProviderUsageWindow | undefined;
    for (const window of windows) {
      if (window.kind !== kind || !window.label.startsWith("Gemini")) continue;
      if (!best || window.usedPercent > best.usedPercent) best = window;
    }
    return best ? { usedPercent: best.usedPercent, ...resetsAtField(best) } : null;
  };
  const session = fullest("session");
  const weekly = fullest("weekly");
  return session || weekly ? { session, weekly } : null;
}
