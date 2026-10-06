import { memo } from "react";
import { KeyboardIcon, KeyboardOffIcon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * Raises or dismisses the on-screen keyboard when the composer is in
 * keyboard-on-demand mode (tapping the text box alone does not). Sized for
 * touch, next to the mic.
 */
export const ComposerKeyboardToggle = memo(function ComposerKeyboardToggle(props: {
  open: boolean;
  disabled: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground/80"
      // Keep focus in the editor so a tap while open closes rather than
      // blurring (which already relocks) and then reopening.
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.open ? props.onClose : props.onOpen}
      disabled={props.disabled}
      aria-label={props.open ? "Hide keyboard" : "Show keyboard"}
      aria-pressed={props.open}
    >
      {props.open ? (
        <KeyboardOffIcon aria-hidden="true" className="size-4" />
      ) : (
        <KeyboardIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
});
