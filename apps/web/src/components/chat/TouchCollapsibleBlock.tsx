import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTouchLayout } from "~/hooks/useTouchLayout";
import { cn } from "~/lib/utils";
import { countTextLines, estimateWrappedLines, shouldTouchCollapse } from "./touchCollapse";

const COLLAPSED_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 3rem), transparent)";

/**
 * Clips long code/diff content to a short preview behind a large Expand
 * button in the touch layout. Renders `children` untouched otherwise.
 * `text` is the raw content; the collapse decision uses its wrapped height so
 * few-but-very-long lines collapse too.
 */
export function TouchCollapsibleBlock(props: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const touchLayout = useTouchLayout();
  const [expanded, setExpanded] = useState(false);
  const visualRows = useMemo(
    () => (touchLayout ? estimateWrappedLines(props.text) : 0),
    [touchLayout, props.text],
  );

  if (!shouldTouchCollapse({ touchLayout, lineCount: visualRows })) {
    return props.children;
  }

  return (
    <div className={props.className} data-touch-collapsed={expanded ? "false" : "true"}>
      <div
        className={cn(!expanded && "max-h-80 overflow-hidden")}
        style={
          expanded
            ? undefined
            : { WebkitMaskImage: COLLAPSED_FADE_MASK, maskImage: COLLAPSED_FADE_MASK }
        }
      >
        {props.children}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        className="flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 border-t border-border/60 bg-muted/40 px-4 font-medium text-base text-foreground/85 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-5 transition-transform", expanded && "rotate-180")}
        />
        {expanded ? "Collapse" : formatExpandLabel(countTextLines(props.text))}
      </button>
    </div>
  );
}

function formatExpandLabel(lineCount: number): string {
  return lineCount > 1 ? `Expand all ${lineCount} lines` : "Expand";
}
