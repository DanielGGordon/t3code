import type { FC } from "react";

import { cn } from "~/lib/utils";
import type { SlackBadgeProps, SlackThreadBadgeVariant } from "../types";

/**
 * The official four-colour Slack "pinwheel" mark. Its palette is fixed by
 * Slack's brand (it is not theme-aware) which is exactly what we want: the mark
 * reads as Slack on both the light and dark sidebar without any `dark:` swap,
 * and its colour makes it the one spot of hue in an otherwise monochrome icon
 * cluster — so a bridged row is spotted at a glance.
 */
const SlackMark: FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 122.8 122.8"
    role="img"
    aria-label="Slack"
    className={className}
  >
    <path
      fill="#E01E5A"
      d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9C5.8 90.5 0 84.7 0 77.6c0-7.1 5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
    />
    <path
      fill="#36C5F0"
      d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9C32.3 5.8 38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
    />
    <path
      fill="#2EB67D"
      d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
    />
    <path
      fill="#ECB22E"
      d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
    />
  </svg>
);

const Badge: FC<SlackBadgeProps> = ({ density, isActive, isMuted, className }) => (
  <span
    title="Bridged from Slack"
    className={cn(
      "inline-flex shrink-0 items-center justify-center",
      // Match the receding hierarchy: on settled / in-flight rows the mark
      // steps back alongside the muted title and the opacity-60 provider icon,
      // but an active row always shows it at full strength.
      isMuted && !isActive ? "opacity-70" : "opacity-100",
      className,
    )}
  >
    {/* Peers with the provider / remote glyphs in the trailing cluster at 14px;
        a hair larger on the taller card rows so the colour mark holds its own,
        smaller on the dense classic v1 row. */}
    <SlackMark
      className={cn(
        "shrink-0",
        density === "card" ? "size-4" : density === "v1" ? "size-3" : "size-3.5",
      )}
    />
  </span>
);

export const opus48Variant: SlackThreadBadgeVariant = {
  id: "opus48",
  author: "Claude Opus 4.8",
  label: "Pinwheel corner mark",
  description:
    "The official four-colour Slack pinwheel tucked into the row's trailing icon cluster beside the provider glyph, with the 'Slack:' prefix stripped so the title reads clean. The lone spot of brand colour flags bridged threads at a glance and needs no theme swap.",
  placement: "trailing",
  stripPrefix: true,
  Badge,
};
