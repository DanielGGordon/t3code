/**
 * Swallows the click a touch gesture leaves behind. A swipe or long press
 * ends in a pointerup that the browser may still turn into a click on the
 * same element; that click must not navigate. The window is bounded so a
 * click that never comes can't eat the user's next real tap.
 */
export const GESTURE_CLICK_SUPPRESSION_MS = 600;

export class GestureClickSuppressor {
  private suppressUntilMs: number | null = null;

  suppress(nowMs: number, windowMs = GESTURE_CLICK_SUPPRESSION_MS): void {
    this.suppressUntilMs = nowMs + windowMs;
  }

  /** True (once) when a click arriving at `nowMs` belongs to a gesture. */
  consume(nowMs: number): boolean {
    const until = this.suppressUntilMs;
    this.suppressUntilMs = null;
    return until !== null && nowMs <= until;
  }
}

/** Touch and pen drive gestures; the mouse keeps click and right-click. */
export function isGesturePointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

type PointerHandlerName = "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel";
type PointerHandlerSet<E> = Record<PointerHandlerName, (event: E) => void>;

/**
 * One element, several gesture recognizers: each sees every pointer event.
 * Undefined in, undefined out, so an inert gesture adds no listeners.
 */
export function composePointerHandlers<E>(
  ...sets: ReadonlyArray<PointerHandlerSet<E> | undefined>
): PointerHandlerSet<E> | undefined {
  const active = sets.filter((set): set is PointerHandlerSet<E> => set !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const compose =
    (name: PointerHandlerName) =>
    (event: E): void => {
      for (const set of active) set[name](event);
    };
  return {
    onPointerDown: compose("onPointerDown"),
    onPointerMove: compose("onPointerMove"),
    onPointerUp: compose("onPointerUp"),
    onPointerCancel: compose("onPointerCancel"),
  };
}
