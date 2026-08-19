import type { FC } from "react";

/**
 * Which sidebar row layout the badge is being rendered into.
 *
 * - `card`  — Sidebar V2 card rows (favicon + project title on line 1, title
 *             on line 2, branch / PR / diff / provider icon on line 3).
 * - `slim`  — Sidebar V2 slim rows (settled / snoozed tail): one line,
 *             favicon + title + PR badge + time.
 * - `v1`    — the classic Sidebar row: status + title on the left, icon
 *             cluster on the right. No favicon.
 */
export type SlackBadgeDensity = "card" | "slim" | "v1";

/**
 * Where the badge sits in the row.
 *
 * - `title-leading`  — inline, immediately before the title text (all layouts).
 * - `title-trailing` — inline, immediately after the title text (all layouts).
 * - `trailing`       — in the row's right-hand icon cluster: next to the
 *                      provider icon on the card's last line, before the time
 *                      label on slim rows, in the right cluster on v1.
 * - `favicon`        — replaces the project favicon (card line 1 / slim
 *                      leading). v1 has no favicon, so it falls back to
 *                      `title-leading` there.
 * - `project-trailing` — after the project title on card line 1 (card only;
 *                      falls back to `trailing` on slim and v1).
 */
export type SlackBadgePlacement =
  | "title-leading"
  | "title-trailing"
  | "trailing"
  | "favicon"
  | "project-trailing";

export interface SlackBadgeProps {
  density: SlackBadgeDensity;
  /** True when the row is the active (selected/open) thread. */
  isActive: boolean;
  /** True when the row is visually receded (settled / snoozed tail). */
  isMuted: boolean;
  className?: string | undefined;
}

export interface SlackThreadBadgeVariant {
  /** Stable id — used by the selector constant and the localStorage override. */
  id: string;
  /** Which model authored this option. */
  author: string;
  /** Short human label for the PR / picker. */
  label: string;
  /** One or two sentences on the design intent. */
  description: string;
  placement: SlackBadgePlacement;
  /**
   * When true the row renders the title without the `Slack:` prefix (the
   * badge carries that information instead). Rename still edits the full
   * stored title.
   */
  stripPrefix?: boolean;
  Badge: FC<SlackBadgeProps>;
}
