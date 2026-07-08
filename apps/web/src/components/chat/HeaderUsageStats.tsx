import type { ClaudeAccountUsage, ClaudeAccountUsageLimit } from "@t3tools/contracts";
import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts/settings";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { Button } from "../ui/button";
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
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";

export type HeaderUsageStatId = "context" | "session" | "weekly" | "scopedWeekly";

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
    id: "context",
    menuLabel: () => "Context window",
    colorClass: "text-accent-cyan",
    patch: (visible) => ({ headerUsageContextVisible: visible }),
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
    context: settings.headerUsageContextVisible,
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
}

function formatLimitPercent(limit: ClaudeAccountUsageLimit): string {
  return `${Math.round(limit.percent)}%`;
}

/**
 * Resolve which big usage readouts to render. A stat is included only when it
 * is toggled on AND its data is available — unavailable stats render nothing
 * rather than a placeholder.
 */
export function selectHeaderUsageStats(input: {
  readonly visibility: HeaderUsageStatsVisibility;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly claudeUsage: ClaudeAccountUsage | null;
}): HeaderUsageStatItem[] {
  const { visibility, contextWindow, claudeUsage } = input;
  const stats: HeaderUsageStatItem[] = [];
  for (const definition of HEADER_USAGE_STAT_DEFINITIONS) {
    if (!visibility[definition.id]) {
      continue;
    }
    switch (definition.id) {
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
      case "session": {
        const limit = findLimit(claudeUsage, "session");
        if (limit) {
          stats.push({
            id: definition.id,
            label: "Session",
            value: formatLimitPercent(limit),
            colorClass: definition.colorClass,
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
  return (
    <div className="hidden shrink-0 items-center gap-8 xl:flex">
      {stats.map((stat) => (
        <div key={stat.id} className="flex flex-col items-start">
          <span className="text-[10px] font-medium uppercase leading-tight tracking-[0.08em] text-muted-foreground">
            {stat.label}
          </span>
          <span className={cn("text-2xl font-semibold leading-none tabular-nums", stat.colorClass)}>
            {stat.value}
          </span>
        </div>
      ))}
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
  onPatch: (patch: ClientSettingsPatch) => void;
}) {
  const { visibility, scopedWeeklyLabel, onPatch } = props;
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
            <MenuCheckboxItem
              key={definition.id}
              variant="switch"
              closeOnClick={false}
              checked={visibility[definition.id]}
              onCheckedChange={(checked) => onPatch(definition.patch(checked))}
            >
              {definition.menuLabel(scopedWeeklyLabel)}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
