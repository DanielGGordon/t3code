import { MoonIcon, SunIcon } from "lucide-react";

import { useTheme } from "~/hooks/useTheme";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Compact light/dark toggle for the app shell header. Toggles the explicit
 * theme preference: when the current preference is "system" it flips to the
 * opposite of the resolved theme, so the first click always changes what the
 * user sees.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch to ${nextTheme} theme`}
            data-testid="theme-toggle"
            className={cn(
              "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
              className,
            )}
            onClick={() => setTheme(nextTheme)}
          >
            {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
            <span className="sr-only">Switch to {nextTheme} theme</span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">Switch to {nextTheme} theme</TooltipPopup>
    </Tooltip>
  );
}
