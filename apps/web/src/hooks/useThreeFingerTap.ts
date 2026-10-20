import { useEffect } from "react";

import {
  MULTI_FINGER_TAP_MAX_DURATION_MS,
  MULTI_FINGER_TAP_MAX_TRAVEL_PX,
  type TouchPoint,
} from "./touchGestures";

const FINGERS = 3;

/**
 * App-wide three-finger tap: exactly three fingers down together, briefly,
 * without moving. A fourth finger, a drag, or a long press cancels it so
 * scrolling, pinching and holding stay inert.
 */
export function useThreeFingerTap(enabled: boolean, onTap: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    let startMs: number | null = null;
    let origins = new Map<number, TouchPoint>();
    let isTap = false;

    const reset = () => {
      startMs = null;
      origins = new Map();
      isTap = false;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length > FINGERS) {
        reset();
        return;
      }
      for (const touch of Array.from(event.touches)) {
        origins.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }
      // Only a touch that reaches three fingers arms a tap; a 2-finger swipe
      // that never gets a third finger stays an ordinary touch.
      if (event.touches.length === FINGERS && startMs === null) {
        startMs = performance.now();
        isTap = true;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!isTap) return;
      for (const touch of Array.from(event.touches)) {
        const origin = origins.get(touch.identifier);
        if (
          origin &&
          Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) >
            MULTI_FINGER_TAP_MAX_TRAVEL_PX
        ) {
          isTap = false;
          return;
        }
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length > 0) return;
      const completed =
        isTap &&
        startMs !== null &&
        performance.now() - startMs <= MULTI_FINGER_TAP_MAX_DURATION_MS;
      reset();
      if (completed) onTap();
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [enabled, onTap]);
}
