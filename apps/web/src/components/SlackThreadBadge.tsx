import { useMemo } from "react";

import { SlackIcon } from "./Icons";
import { getThreadChannel, stripThreadChannelPrefix } from "~/lib/threadChannel";
import { cn } from "~/lib/utils";

/**
 * Sidebar row title for a thread, with channel awareness. Threads bridged in
 * from Slack (`Slack: …` titles) render the Slack mark in place of the
 * literal prefix — the channel is read where the eye already starts, and the
 * row gets those characters back for the actual sentence. Rename still edits
 * the full stored title.
 */
export function useThreadDisplayTitle(title: string): { isSlack: boolean; displayTitle: string } {
  return useMemo(() => {
    const isSlack = getThreadChannel(title) === "slack";
    return { isSlack, displayTitle: isSlack ? stripThreadChannelPrefix(title) : title };
  }, [title]);
}

export type SlackThreadBadgeDensity = "card" | "slim" | "v1";

/**
 * The mark is 14px everywhere (all three sidebar row layouts set the title at
 * `text-sm`, and the pinwheel's negative space collapses below that); density
 * only tunes the gap to the title. Receded rows desaturate and step back so the
 * settled tail keeps its hierarchy, and come back to full colour on row hover.
 * A visually-hidden `Slack:` keeps the channel in the accessible name, since
 * the visible mark replaces the prefix text.
 */
export function SlackThreadBadge({
  density,
  isActive,
  isMuted,
  className,
}: {
  density: SlackThreadBadgeDensity;
  isActive: boolean;
  isMuted: boolean;
  className?: string | undefined;
}) {
  return (
    <>
      <span
        role="img"
        aria-label="Slack conversation"
        title="Bridged from Slack"
        className={cn(
          "inline-flex size-3.5 align-[-0.15em] transition-[opacity,filter] duration-150",
          density === "v1" ? "mr-1" : "mr-1.5",
          isMuted
            ? "opacity-65 saturate-[0.8] dark:opacity-55"
            : isActive
              ? "opacity-100"
              : "opacity-90",
          isMuted &&
            density !== "v1" &&
            "group-hover/v2-row:opacity-100 group-hover/v2-row:saturate-100",
          className,
        )}
      >
        <SlackIcon aria-hidden focusable="false" className="size-full shrink-0" />
      </span>
      <span className="sr-only">Slack: </span>
    </>
  );
}
