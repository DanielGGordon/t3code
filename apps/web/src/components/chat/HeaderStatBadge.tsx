import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

// Shared shell for the compact stat chips in the chat header: an outline
// button trigger that reveals a detail popover on hover.
export function HeaderStatBadge(props: {
  ariaLabel: string;
  tone?: "default" | "warning" | "critical";
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 text-muted-foreground data-[tone=critical]:text-destructive data-[tone=warning]:text-warning-foreground"
            data-tone={props.tone ?? "default"}
            aria-label={props.ariaLabel}
          />
        }
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        align="end"
        padding="compact"
        className="w-max max-w-none"
      >
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}
