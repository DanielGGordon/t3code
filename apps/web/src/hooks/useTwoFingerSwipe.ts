import { useEffect } from "react";

import { classifyTwoFingerSwipe, couldBeTwoFingerSwipe, type TouchPoint } from "./touchGestures";

interface TwoFingerSwipeHandlers {
  readonly onSwipeUp: () => void;
  readonly onSwipeDown: () => void;
}

function pointOf(touch: Touch): TouchPoint {
  return { x: touch.clientX, y: touch.clientY };
}

/**
 * App-wide two-finger vertical swipe. Listens on the document so it works
 * over any view; a third finger, or lifting one finger early, cancels it.
 * Both touches are tracked by identifier so unrelated one-finger taps and
 * scrolls never reach the recognizer.
 */
export function useTwoFingerSwipe(enabled: boolean, handlers: TwoFingerSwipeHandlers): void {
  const { onSwipeUp, onSwipeDown } = handlers;
  useEffect(() => {
    if (!enabled) return;
    let start: [TouchPoint, TouchPoint] | null = null;
    let ids: [number, number] | null = null;
    let last: [TouchPoint, TouchPoint] | null = null;

    const reset = () => {
      start = null;
      ids = null;
      last = null;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        reset();
        return;
      }
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!a || !b) return;
      start = [pointOf(a), pointOf(b)];
      last = start;
      ids = [a.identifier, b.identifier];
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!ids || !start || event.touches.length !== 2) return;
      const a = Array.from(event.touches).find((t) => t.identifier === ids?.[0]);
      const b = Array.from(event.touches).find((t) => t.identifier === ids?.[1]);
      if (!a || !b) return;
      last = [pointOf(a), pointOf(b)];
      // The page begins scrolling on the first moves, well before the swipe
      // is long enough to classify, and a scroll in progress can't be
      // cancelled. Claim the touch from the start while it can still be a swipe.
      if (couldBeTwoFingerSwipe(start, last) && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = () => {
      const gesture = start && last ? classifyTwoFingerSwipe(start, last) : null;
      reset();
      if (gesture === "up") onSwipeUp();
      else if (gesture === "down") onSwipeDown();
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [enabled, onSwipeUp, onSwipeDown]);
}
