import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

// Shared shell for the compact stat chips in the chat header: an outline
// button trigger that reveals a detail popover on hover.
export function HeaderStatBadge(props: {
  ariaLabel: string;
  triggerClassName?: string;
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
            className={cn("shrink-0 gap-1 text-muted-foreground", props.triggerClassName)}
            aria-label={props.ariaLabel}
          />
        }
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="bottom" align="end" className="w-max max-w-none px-3 py-2">
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}
