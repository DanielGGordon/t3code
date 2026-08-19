import { useMemo, type ReactNode } from "react";

import { getThreadChannel, stripThreadChannelPrefix } from "~/lib/threadChannel";
import type {
  SlackBadgeDensity,
  SlackBadgePlacement,
  SlackBadgeProps,
  SlackThreadBadgeVariant,
} from "./types";
import { fableVariant } from "./variants/fable";
import { grok46Variant } from "./variants/grok46";
import { opus48Variant } from "./variants/opus48";
import { opus5Variant } from "./variants/opus5";
import { sol56Variant } from "./variants/sol56";

export type {
  SlackBadgeDensity,
  SlackBadgePlacement,
  SlackBadgeProps,
  SlackThreadBadgeVariant,
} from "./types";

/**
 * Every candidate treatment, keyed by id. Each file under `./variants` is one
 * model's take on "how should a Slack-bridged thread look in the sidebar?".
 * Once a winner is picked the losers (and this registry) can be deleted.
 */
export const SLACK_THREAD_BADGE_VARIANTS: Record<string, SlackThreadBadgeVariant> = {
  [fableVariant.id]: fableVariant,
  [opus5Variant.id]: opus5Variant,
  [opus48Variant.id]: opus48Variant,
  [grok46Variant.id]: grok46Variant,
  [sol56Variant.id]: sol56Variant,
};

/** The option that ships unless overridden (see below). */
export const SLACK_THREAD_BADGE_DEFAULT_VARIANT_ID: string = fableVariant.id;

/**
 * Temporary review aid: set `localStorage["t3:slackThreadBadgeVariant"]` to a
 * variant id to flip the treatment without a rebuild. Read once at module
 * load — reload the page after changing it. Remove with the registry.
 */
export const SLACK_THREAD_BADGE_OVERRIDE_STORAGE_KEY = "t3:slackThreadBadgeVariant";

function readOverride(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(SLACK_THREAD_BADGE_OVERRIDE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function resolveSlackThreadBadgeVariant(): SlackThreadBadgeVariant {
  const override = readOverride();
  if (override && SLACK_THREAD_BADGE_VARIANTS[override]) {
    return SLACK_THREAD_BADGE_VARIANTS[override]!;
  }
  return SLACK_THREAD_BADGE_VARIANTS[SLACK_THREAD_BADGE_DEFAULT_VARIANT_ID] ?? fableVariant;
}

const ACTIVE_VARIANT = resolveSlackThreadBadgeVariant();

/**
 * Placement fallbacks per layout: v1 rows have no favicon and only the card
 * has a project-title line, so those placements degrade to the nearest slot.
 */
export function effectiveSlackBadgePlacement(
  placement: SlackBadgePlacement,
  density: SlackBadgeDensity,
): SlackBadgePlacement {
  if (placement === "favicon" && density === "v1") return "title-leading";
  if (placement === "project-trailing" && density !== "card") return "trailing";
  return placement;
}

export interface ResolvedSlackThreadBadge {
  variant: SlackThreadBadgeVariant;
  /** Title to display (prefix stripped when the variant asks for it). */
  displayTitle: string;
  /**
   * Visually-hidden `Slack:` prefix to render immediately before
   * `displayTitle` when the variant strips it, so the row's accessible name
   * still says "Slack" even though the visible mark sits in an `aria-hidden`
   * cluster. Null when nothing was stripped.
   */
  srPrefix: ReactNode;
  /** True when this layout should render the badge in place of the project favicon. */
  replacesFavicon: (density: SlackBadgeDensity) => boolean;
  /** Render the badge if the variant wants it in `slot` for this layout; else null. */
  at: (slot: SlackBadgePlacement, props: SlackBadgeProps) => ReactNode;
}

function resolveForTitle(title: string): ResolvedSlackThreadBadge | null {
  if (getThreadChannel(title) !== "slack") return null;
  const variant = ACTIVE_VARIANT;
  const Badge = variant.Badge;
  return {
    variant,
    displayTitle: variant.stripPrefix ? stripThreadChannelPrefix(title) : title,
    srPrefix: variant.stripPrefix ? <span className="sr-only">Slack: </span> : null,
    replacesFavicon: (density) =>
      effectiveSlackBadgePlacement(variant.placement, density) === "favicon",
    at: (slot, props) =>
      effectiveSlackBadgePlacement(variant.placement, props.density) === slot ? (
        <Badge {...props} />
      ) : null,
  };
}

/** Row-level hook: null for ordinary threads, a resolved badge for `Slack:` ones. */
export function useSlackThreadBadge(title: string): ResolvedSlackThreadBadge | null {
  return useMemo(() => resolveForTitle(title), [title]);
}
