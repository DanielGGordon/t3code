import { cn } from "~/lib/utils";

import type { SlackThreadBadgeVariant } from "../types";

export const sol56Variant: SlackThreadBadgeVariant = {
  id: "sol56",
  author: "GPT-5.6 Sol",
  label: "Quiet pinwheel",
  description:
    "A crisp, full-color Slack pinwheel sits with the row metadata, keeping the title clean while making bridged threads recognizable at a glance. Its restrained opacity follows the row hierarchy without losing brand recognition.",
  placement: "trailing",
  stripPrefix: true,
  Badge: ({ density, isActive, isMuted, className }) => (
    <span
      title="Slack conversation"
      className={cn(
        "inline-flex shrink-0 items-center justify-center transition-opacity",
        density === "slim" ? "size-3.5" : "size-4",
        isMuted ? "opacity-50 saturate-75" : isActive ? "opacity-100" : "opacity-80",
        className,
      )}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-full" fill="none">
        <rect x="6.6" y="0.5" width="2.8" height="6.2" rx="1.4" fill="#36C5F0" />
        <circle cx="5.1" cy="5.1" r="1.4" fill="#36C5F0" />
        <rect x="9.3" y="6.6" width="6.2" height="2.8" rx="1.4" fill="#2EB67D" />
        <circle cx="10.9" cy="5.1" r="1.4" fill="#2EB67D" />
        <rect x="6.6" y="9.3" width="2.8" height="6.2" rx="1.4" fill="#ECB22E" />
        <circle cx="10.9" cy="10.9" r="1.4" fill="#ECB22E" />
        <rect x="0.5" y="6.6" width="6.2" height="2.8" rx="1.4" fill="#E01E5A" />
        <circle cx="5.1" cy="10.9" r="1.4" fill="#E01E5A" />
      </svg>
    </span>
  ),
};
