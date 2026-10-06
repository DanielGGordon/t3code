import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

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

const SCOPED_LABEL_PREFIX = /^weekly\s*[·:-]\s*/i;

function findUsageWindows(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
): ReadonlyArray<ServerProviderUsageWindow> | null {
  for (const provider of providers) {
    if (provider.driver !== driver || !provider.enabled) continue;
    const windows = provider.usageLimits?.windows;
    if (windows && windows.length > 0) return windows;
  }
  return null;
}

function resetsAtField(window: ServerProviderUsageWindow): { resetsAt?: string } {
  return window.resetsAt ? { resetsAt: String(window.resetsAt) } : {};
}

/** Claude plan windows from the first enabled Claude provider that reports any. */
export function selectClaudeUsage(
  providers: ReadonlyArray<ServerProvider>,
): HeaderClaudeUsage | null {
  const windows = findUsageWindows(providers, "claudeAgent");
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
): HeaderCodexUsage | null {
  const windows = findUsageWindows(providers, "codex");
  if (windows === null) return null;
  const toWindow = (window: ServerProviderUsageWindow | undefined): HeaderCodexWindow | null =>
    window ? { usedPercent: window.usedPercent, ...resetsAtField(window) } : null;
  const primary = toWindow(windows.find((window) => window.kind === "session"));
  const secondary = toWindow(windows.find((window) => window.kind === "weekly"));
  return primary || secondary ? { primary, secondary } : null;
}
