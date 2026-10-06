/**
 * Touch layout's swipe-left snooze picker: four big fixed preset targets
 * instead of the hover clock button's dropdown. One dialog owned by the
 * sidebar list (not one per row); the presets resolve when the swipe opens
 * it, so "In 1 hour" is relative to the swipe.
 */
import type { SnoozePreset } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface TouchSnoozePickerTarget<TRef> {
  readonly threadRef: TRef;
  readonly title: string;
  readonly presets: ReadonlyArray<SnoozePreset>;
}

export function TouchSnoozePicker<TRef>(props: {
  target: TouchSnoozePickerTarget<TRef> | null;
  onPick: (threadRef: TRef, preset: SnoozePreset) => void;
  onClose: () => void;
}) {
  const { target, onPick, onClose } = props;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false} bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Snooze until</DialogTitle>
          <DialogDescription>
            <span className="block truncate">{target?.title}</span>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {/* 12px gaps: adjacent commit targets on a moving touchscreen. */}
          <div className="grid grid-cols-2 gap-3">
            {target?.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`sidebar-touch-snooze-${preset.id}`}
                onClick={() => {
                  onClose();
                  onPick(target.threadRef, preset);
                }}
                className="flex min-h-18 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-base font-medium text-foreground">{preset.label}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {preset.whenLabel}
                </span>
              </button>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="xl" className="h-14 w-full sm:h-14" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
