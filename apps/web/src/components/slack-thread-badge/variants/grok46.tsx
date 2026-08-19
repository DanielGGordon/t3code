import { cn } from "~/lib/utils";
import type { SlackBadgeProps, SlackThreadBadgeVariant } from "../types";

/**
 * Official Slack pinwheel (four lozenges). Paths are the public brand mark;
 * sized to stay legible at 14px without a backing tile — matching Git/GitLab
 * in this sidebar rather than an app-icon plate.
 */
function SlackPinwheel({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 122.8 122.8" fill="none" aria-hidden focusable="false" className={className}>
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

function Badge({ density, isActive, isMuted, className }: SlackBadgeProps) {
  return (
    <span
      title="Slack"
      className={cn(
        "inline-flex shrink-0 items-center justify-center align-text-bottom",
        density === "card" ? "mr-1.5 size-3.5" : "mr-1 size-3.5",
        isActive
          ? "opacity-100"
          : isMuted
            ? "opacity-45 transition-opacity group-hover/v2-row:opacity-90"
            : "opacity-90",
        className,
      )}
    >
      <SlackPinwheel className="size-full" />
    </span>
  );
}

export const grok46Variant: SlackThreadBadgeVariant = {
  id: "grok46",
  author: "Grok 4.6",
  label: "Pinwheel, title-leading",
  description:
    "Official four-colour Slack pinwheel leading the title in place of the “Slack:” prefix — the mark is the channel, so the title can just be the title. Dims with receded rows, full chroma when the thread is active.",
  placement: "title-leading",
  stripPrefix: true,
  Badge,
};
