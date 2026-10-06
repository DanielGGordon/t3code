import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

export type ComposerTouchButtonTone = "primary" | "outline" | "ghost";
export type ComposerTouchButtonSize = "default" | "large" | "icon";

/**
 * The touch layout's composer controls: round, driver-reachable pills sized for
 * a car screen (56px, or 64px for the primary voice control). A composer-owned
 * control rather than a restyled Button, like ComposerControl and the
 * message-action pills, so it owns its classes.
 */
function composerTouchButtonClassName(
  tone: ComposerTouchButtonTone,
  size: ComposerTouchButtonSize,
  className?: string,
) {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-full border font-medium text-lg outline-none transition-[scale,background-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.97] disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-6",
    size === "large" ? "h-16 px-6" : size === "icon" ? "size-14" : "h-14 px-5",
    tone === "primary" &&
      "border-message-action bg-message-action text-message-action-foreground shadow-xs shadow-message-action/24 hover:bg-message-action-hover",
    tone === "outline" && "border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent/50",
    tone === "ghost" &&
      "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
    "aria-pressed:bg-accent aria-pressed:text-accent-foreground",
    className,
  );
}

type ComposerTouchButtonProps = useRender.ComponentProps<"button"> & {
  tone?: ComposerTouchButtonTone;
  size?: ComposerTouchButtonSize;
};

export function ComposerTouchButton({
  className,
  tone = "ghost",
  size = "default",
  render,
  ...props
}: ComposerTouchButtonProps) {
  const defaultProps = {
    className: composerTouchButtonClassName(tone, size, className),
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
