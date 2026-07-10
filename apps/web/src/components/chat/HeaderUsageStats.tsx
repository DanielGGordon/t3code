import type {
  ClaudeAccountUsage,
  ClaudeAccountUsageLimit,
  CodexUsageResult,
  StockQuote,
  StockQuoteResult,
} from "@t3tools/contracts";
import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts/settings";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";

export type HeaderUsageStatId =
  | "codex"
  | "stock"
  | "context"
  | "spend"
  | "session"
  | "weekly"
  | "scopedWeekly";

export type HeaderUsageStatsVisibility = Readonly<Record<HeaderUsageStatId, boolean>>;

export const FALLBACK_SCOPED_WEEKLY_LABEL = "Scoped";

interface HeaderUsageStatDefinition {
  readonly id: HeaderUsageStatId;
  /** Wording of the show/hide toggle in the header usage menu. */
  readonly menuLabel: (scopedWeeklyLabel: string) => string;
  /**
   * Accent color for the big readout. The `--color-accent-*` tokens keep the
   * same hue in both light and dark themes, so no `dark:` variant is needed.
   */
  readonly colorClass: string;
  readonly patch: (visible: boolean) => ClientSettingsPatch;
}

export const HEADER_USAGE_STAT_DEFINITIONS: ReadonlyArray<HeaderUsageStatDefinition> = [
  {
    id: "codex",
    menuLabel: () => "Codex usage",
    colorClass: "text-accent-orange",
    patch: (visible) => ({ headerUsageCodexVisible: visible }),
  },
  {
    id: "stock",
    menuLabel: () => "Stock ticker",
    // Color is chosen per-render from the price direction, so this is only a
    // neutral fallback (used before a quote loads).
    colorClass: "text-foreground",
    patch: (visible) => ({ headerUsageStockVisible: visible }),
  },
  {
    id: "context",
    menuLabel: () => "Context window",
    colorClass: "text-accent-cyan",
    patch: (visible) => ({ headerUsageContextVisible: visible }),
  },
  {
    id: "spend",
    menuLabel: () => "Spend (est.)",
    colorClass: "text-accent-green",
    patch: (visible) => ({ headerUsageSpendVisible: visible }),
  },
  {
    id: "session",
    menuLabel: () => "Claude session",
    colorClass: "text-accent-blue",
    patch: (visible) => ({ headerUsageSessionVisible: visible }),
  },
  {
    id: "weekly",
    menuLabel: () => "Claude weekly",
    colorClass: "text-accent-violet",
    patch: (visible) => ({ headerUsageWeeklyVisible: visible }),
  },
  {
    id: "scopedWeekly",
    menuLabel: (scopedWeeklyLabel) => `Claude weekly · ${scopedWeeklyLabel}`,
    colorClass: "text-accent-magenta",
    patch: (visible) => ({ headerUsageScopedWeeklyVisible: visible }),
  },
];

export function selectHeaderUsageStatsVisibility(
  settings: ClientSettings,
): HeaderUsageStatsVisibility {
  return {
    codex: settings.headerUsageCodexVisible,
    stock: settings.headerUsageStockVisible,
    context: settings.headerUsageContextVisible,
    spend: settings.headerUsageSpendVisible,
    session: settings.headerUsageSessionVisible,
    weekly: settings.headerUsageWeeklyVisible,
    scopedWeekly: settings.headerUsageScopedWeeklyVisible,
  };
}

function findLimit(usage: ClaudeAccountUsage | null, kind: string): ClaudeAccountUsageLimit | null {
  return usage?.limits.find((limit) => limit.kind === kind) ?? null;
}

/** Display label for the scoped weekly limit (e.g. a model-family scope). */
export function resolveScopedWeeklyLabel(usage: ClaudeAccountUsage | null): string {
  return findLimit(usage, "weekly_scoped")?.scopeLabel ?? FALLBACK_SCOPED_WEEKLY_LABEL;
}

export interface HeaderUsageStatItem {
  readonly id: HeaderUsageStatId;
  /** Small muted caption rendered above the value (uppercased by CSS). */
  readonly label: string;
  /** Big formatted readout, e.g. "167k" or "42%". */
  readonly value: string;
  readonly colorClass: string;
  /** Optional caveat shown on hover (e.g. spend is an estimate, not a bill). */
  readonly tooltip?: string;
  /**
   * ISO timestamp when this limit's window resets, when applicable. Rendered on
   * hover as a relative countdown (e.g. "Resets in 3d12h6m").
   */
  readonly resetsAt?: string;
}

/**
 * Relative countdown until `resetsAt`, e.g. "36m", "4h36m", "3d12h6m". Seconds
 * are intentionally dropped. Returns null for a missing/invalid timestamp or
 * one already in the past (the next usage refresh will clear it).
 */
export function formatResetCountdown(resetsAt: string, nowMs: number): string | null {
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) {
    return null;
  }
  const remainingMs = target - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (days > 0 || hours > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);
  return parts.join("");
}

export const SPEND_STAT_TOOLTIP =
  "Estimated API-equivalent cost from token counts at list prices. Not a bill — subscription (Max / ChatGPT plan) usage is included in your plan.";

/** Shown instead when part of the thread's usage has no list price. */
export const SPEND_STAT_PARTIAL_TOOLTIP = `${SPEND_STAT_TOOLTIP} Part of this thread's usage ran on a model with no published list price and is not included in this total.`;

function formatLimitPercent(limit: ClaudeAccountUsageLimit): string {
  return `${Math.round(limit.percent)}%`;
}

/**
 * Hover tooltip for the Codex usage stat: the 5-hour and weekly windows with
 * their used percentage and reset countdowns. The big readout shows only the
 * 5h percentage; the rest lives here.
 */
function formatCodexUsageTooltip(usage: CodexUsageResult): string {
  const now = Date.now();
  const segments: string[] = [];
  const describe = (
    label: string,
    window: { readonly usedPercent: number; readonly resetsAt: number | null } | null,
  ): void => {
    if (!window) {
      return;
    }
    const countdown =
      window.resetsAt !== null
        ? formatResetCountdown(new Date(window.resetsAt * 1000).toISOString(), now)
        : null;
    segments.push(
      `${label} ${Math.round(window.usedPercent)}%${countdown ? ` · resets in ${countdown}` : ""}`,
    );
  };
  describe("5h", usage?.primary ?? null);
  describe("Weekly", usage?.secondary ?? null);
  return segments.join(" · ");
}

const CURRENCY_PREFIXES: Readonly<Record<string, string>> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/** Compact price readout, e.g. "$612.34" or "1,234.50". */
function formatStockPrice(quote: StockQuote): string {
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(quote.price);
  const prefix = quote.currency ? (CURRENCY_PREFIXES[quote.currency] ?? "") : "";
  return `${prefix}${formatted}`;
}

/** Green when up, red when down, muted when the change is unknown. */
function stockColorClass(quote: StockQuote | null): string {
  if (!quote || quote.changePercent === null) {
    return "text-muted-foreground";
  }
  return quote.changePercent >= 0 ? "text-accent-green" : "text-accent-red";
}

/** Hover tooltip: the percent change for the day, or a muted caveat. */
function formatStockChangeTooltip(quote: StockQuote | null): string {
  if (!quote) {
    return "Quote unavailable";
  }
  if (quote.changePercent === null) {
    return "Change unavailable";
  }
  const sign = quote.changePercent >= 0 ? "+" : "";
  return `${sign}${quote.changePercent.toFixed(2)}% today`;
}

/**
 * Resolve which big usage readouts to render. A stat is included only when it
 * is toggled on AND its data is available — unavailable stats render nothing
 * rather than a placeholder. The stock ticker is the exception: once toggled on
 * with a symbol it always renders (a muted "—" until a quote arrives), so it
 * stays a stable, editable anchor.
 */
export function selectHeaderUsageStats(input: {
  readonly visibility: HeaderUsageStatsVisibility;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly claudeUsage: ClaudeAccountUsage | null;
  readonly codexUsage?: CodexUsageResult;
  readonly stockQuote?: StockQuoteResult;
  readonly stockSymbol?: string;
}): HeaderUsageStatItem[] {
  const { visibility, contextWindow, claudeUsage } = input;
  const codexUsage = input.codexUsage ?? null;
  const stockQuote = input.stockQuote ?? null;
  const stats: HeaderUsageStatItem[] = [];
  for (const definition of HEADER_USAGE_STAT_DEFINITIONS) {
    if (!visibility[definition.id]) {
      continue;
    }
    switch (definition.id) {
      case "codex": {
        const primary = codexUsage?.primary ?? null;
        if (primary) {
          stats.push({
            id: definition.id,
            label: "Codex",
            value: `${Math.round(primary.usedPercent)}%`,
            colorClass: definition.colorClass,
            tooltip: formatCodexUsageTooltip(codexUsage),
          });
        }
        break;
      }
      case "stock": {
        const symbol = input.stockSymbol?.trim();
        if (symbol) {
          stats.push({
            id: definition.id,
            label: stockQuote?.symbol ?? symbol.toUpperCase(),
            value: stockQuote ? formatStockPrice(stockQuote) : "—",
            colorClass: stockColorClass(stockQuote),
            tooltip: formatStockChangeTooltip(stockQuote),
          });
        }
        break;
      }
      case "context": {
        if (contextWindow) {
          stats.push({
            id: definition.id,
            label: "Context",
            value: formatContextWindowTokens(contextWindow.usedTokens),
            colorClass: definition.colorClass,
          });
        }
        break;
      }
      case "spend": {
        const value = formatCostUsd(contextWindow?.threadTotalCostUsd ?? null);
        if (value !== null) {
          const partial = contextWindow?.threadTotalCostUsdIncomplete === true;
          stats.push({
            id: definition.id,
            label: partial ? "Spend (partial)" : "Spend",
            value,
            colorClass: definition.colorClass,
            tooltip: partial ? SPEND_STAT_PARTIAL_TOOLTIP : SPEND_STAT_TOOLTIP,
          });
        }
        break;
      }
      case "session": {
        const limit = findLimit(claudeUsage, "session");
        if (limit) {
          stats.push({
            id: definition.id,
            label: "Session",
            value: formatLimitPercent(limit),
            colorClass: definition.colorClass,
            ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          });
        }
        break;
      }
      case "weekly": {
        const limit = findLimit(claudeUsage, "weekly_all");
        if (limit) {
          stats.push({
            id: definition.id,
            label: "Weekly",
            value: formatLimitPercent(limit),
            colorClass: definition.colorClass,
            ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          });
        }
        break;
      }
      case "scopedWeekly": {
        const limit = findLimit(claudeUsage, "weekly_scoped");
        if (limit) {
          stats.push({
            id: definition.id,
            label: limit.scopeLabel ?? FALLBACK_SCOPED_WEEKLY_LABEL,
            value: formatLimitPercent(limit),
            colorClass: definition.colorClass,
            ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          });
        }
        break;
      }
    }
  }
  return stats;
}

/**
 * Big usage readouts filling the chat header's otherwise-blank middle area.
 * Hidden below the `xl` breakpoint so mobile/tablet layouts are untouched.
 */
export function HeaderUsageStats(props: { stats: ReadonlyArray<HeaderUsageStatItem> }) {
  const { stats } = props;
  if (stats.length === 0) {
    return null;
  }
  const now = Date.now();
  return (
    <div className="hidden shrink-0 items-center gap-8 xl:flex">
      {stats.map((stat) => {
        const resetCountdown = stat.resetsAt ? formatResetCountdown(stat.resetsAt, now) : null;
        const tooltipContent =
          stat.tooltip ?? (resetCountdown ? `Resets in ${resetCountdown}` : null);
        const block = (
          <div key={stat.id} className="flex flex-col items-start">
            <span className="text-[10px] font-medium uppercase leading-tight tracking-[0.08em] text-muted-foreground">
              {stat.label}
            </span>
            <span
              className={cn("text-2xl font-semibold leading-none tabular-nums", stat.colorClass)}
            >
              {stat.value}
            </span>
          </div>
        );
        if (!tooltipContent) {
          return block;
        }
        return (
          <Tooltip key={stat.id}>
            <TooltipTrigger render={block} />
            <TooltipPopup className="max-w-72">{tooltipContent}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Small header-actions menu with one switch per big usage readout. Hidden
 * below `xl` alongside the stats strip it controls.
 */
export function HeaderUsageStatsMenu(props: {
  visibility: HeaderUsageStatsVisibility;
  scopedWeeklyLabel: string;
  stockSymbol: string;
  onPatch: (patch: ClientSettingsPatch) => void;
}) {
  const { visibility, scopedWeeklyLabel, stockSymbol, onPatch } = props;
  const [symbolDraft, setSymbolDraft] = useState(stockSymbol);
  // Keep the draft in sync when the persisted symbol changes elsewhere.
  useEffect(() => {
    setSymbolDraft(stockSymbol);
  }, [stockSymbol]);
  const commitSymbol = () => {
    const normalized = symbolDraft.trim().toUpperCase();
    if (normalized.length === 0) {
      setSymbolDraft(stockSymbol);
      return;
    }
    setSymbolDraft(normalized);
    if (normalized !== stockSymbol) {
      onPatch({ headerUsageStockSymbol: normalized });
    }
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  type="button"
                  aria-label="Configure header usage stats"
                  className="hidden xl:inline-flex"
                />
              }
            />
          }
        >
          <ChartNoAxesColumnIcon />
        </TooltipTrigger>
        <TooltipPopup>Usage stats</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Header usage stats</MenuGroupLabel>
          {HEADER_USAGE_STAT_DEFINITIONS.map((definition) => (
            <Fragment key={definition.id}>
              <MenuCheckboxItem
                variant="switch"
                closeOnClick={false}
                checked={visibility[definition.id]}
                onCheckedChange={(checked) => onPatch(definition.patch(checked))}
              >
                {definition.menuLabel(scopedWeeklyLabel)}
              </MenuCheckboxItem>
              {definition.id === "stock" && (
                // Symbol editor for the ticker. It lives in the popup, so guard
                // against the menu's typeahead/navigation stealing keystrokes.
                <div
                  className="px-2 pb-1.5 pt-1"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Input
                    size="sm"
                    value={symbolDraft}
                    aria-label="Stock ticker symbol"
                    placeholder="SPY"
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="characters"
                    className="text-xs uppercase tracking-wide"
                    onChange={(event) => setSymbolDraft(event.target.value)}
                    onBlur={commitSymbol}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitSymbol();
                        event.currentTarget.blur();
                      } else if (event.key === "Escape") {
                        setSymbolDraft(stockSymbol);
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </div>
              )}
            </Fragment>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
