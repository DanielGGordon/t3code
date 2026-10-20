import { useEffect } from "react";

import {
  MULTI_FINGER_TAP_MAX_DURATION_MS,
  MULTI_FINGER_TAP_MAX_TRAVEL_PX,
  RepeatedTapCounter,
  type TouchPoint,
} from "./touchGestures";

const FINGERS = 3;
const TAPS = 3;

/**
 * App-wide three-finger triple tap. Each tap puts exactly three fingers down
 * briefly without moving them; a fourth finger, a drag, or a long press
 * discards the tap so scrolling, pinching and holding stay inert.
 */
export function useThreeFingerTripleTap(enabled: boolean, onTriple: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const counter = new RepeatedTapCounter(TAPS);
    let startMs: number | null = null;
    let origins = new Map<number, TouchPoint>();
    let isTap = false;

    const endTouch = () => {
      startMs = null;
      origins = new Map();
      isTap = false;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length > FINGERS) {
        endTouch();
        counter.reset();
        return;
      }
      // A tap needs all three fingers down together; staggered or fewer
      // fingers are ordinary touches, and a 2-finger swipe must not arm one.
      for (const touch of Array.from(event.touches)) {
        origins.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }
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
          counter.reset();
          return;
        }
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length > 0) return;
      const now = performance.now();
      const completed =
        isTap && startMs !== null && now - startMs <= MULTI_FINGER_TAP_MAX_DURATION_MS;
      const wasThreeFingerTouch = startMs !== null;
      endTouch();
      if (completed) {
        if (counter.register(now)) onTriple();
      } else if (wasThreeFingerTouch) {
        counter.reset();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", endTouch, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", endTouch);
    };
  }, [enabled, onTriple]);
}
