import { ChevronDownIcon } from "lucide-react";
import { useTouchLayout } from "~/hooks/useTouchLayout";
import { Button } from "../ui/button";

/**
 * The timeline's "Scroll to end" pill. ChatView measures it by its aria-label
 * to keep it clear of the composer, so keep the label stable. The touch layout
 * swaps in a 56px finger target.
 */
export function ScrollToEndButton(props: { onClick: () => void }) {
  const touchLayout = useTouchLayout();
  return (
    <Button
      aria-label="Scroll to end"
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className="pointer-events-auto"
      size={touchLayout ? "2xl" : "xs"}
      variant="glass"
    >
      <ChevronDownIcon className={touchLayout ? "size-5" : "size-3.5"} />
      Scroll to end
    </Button>
  );
}
