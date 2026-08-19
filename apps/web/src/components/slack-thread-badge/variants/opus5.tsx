import { cn } from "~/lib/utils";
import type { SlackBadgeDensity, SlackBadgeProps, SlackThreadBadgeVariant } from "../types";

/**
 * The official Slack "pinwheel" mark: four rounded-bar pairs in the brand
 * palette. Drawn from the published brand asset (viewBox 122.8) so the corner
 * radii stay true at small sizes — the shape is what makes it legible at 14px,
 * the colour is what makes it findable in a column of grey glyphs.
 */
function SlackMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 122.8 122.8"
      aria-hidden
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <path
        fill="#E01E5A"
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
      />
      <path
        fill="#36C5F0"
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
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
}

/**
 * All three layouts set the title at `text-sm`, so the mark is 14px everywhere
 * — one size keeps the pinwheel's thin negative space from collapsing, and the
 * badge stays inside the same budget as the 14px provider icon. Density only
 * tunes the gap to the title: cards and slim rows breathe, the 28px v1 row
 * doesn't. The negative `align` drops the box so its optical centre lands on
 * the text's, instead of the mark riding above the baseline.
 */
const DENSITY_CLASS: Record<SlackBadgeDensity, string> = {
  card: "mr-1.5 size-3.5 align-[-0.15em]",
  slim: "mr-1.5 size-3.5 align-[-0.15em]",
  v1: "mr-1 size-3.5 align-[-0.15em]",
};

function Badge({ density, isActive, isMuted, className }: SlackBadgeProps) {
  return (
    <span
      role="img"
      aria-label="Slack conversation"
      title="Bridged from Slack"
      className={cn(
        "inline-flex transition-[opacity,filter] duration-150",
        DENSITY_CLASS[density],
        // Receded rows: the mark desaturates and steps back so the settled
        // tail keeps its hierarchy. Colour fades faster against a light
        // surface than a dark one, so light mode holds a little more opacity.
        isMuted
          ? "opacity-65 saturate-[0.8] dark:opacity-55"
          : isActive
            ? "opacity-100"
            : "opacity-90",
        // …and comes back to full colour when you sweep the row, mirroring how
        // the slim row's own favicon un-dims on hover. (V2 rows only — the v1
        // sidebar has no such group, so the mark simply stays put there.)
        isMuted &&
          density !== "v1" &&
          "group-hover/v2-row:opacity-100 group-hover/v2-row:saturate-100",
        className,
      )}
    >
      <SlackMark className="size-full" />
    </span>
  );
}

export const opus5Variant: SlackThreadBadgeVariant = {
  id: "opus5",
  author: "Claude Opus 5",
  label: "Pinwheel in place of the prefix",
  description:
    "The four-colour Slack mark takes the place of the literal `Slack:` text at the head of the title, so the channel is read at the point where the eye already starts and the row gets those characters back for the actual sentence. Identical treatment in all three row layouts, receding with the row and returning to full colour on hover.",
  placement: "title-leading",
  stripPrefix: true,
  Badge,
};
