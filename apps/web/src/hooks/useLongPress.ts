import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { GestureClickSuppressor, isGesturePointer } from "./touchGestures";

/**
 * Press-and-hold for touch/pen (touch layout). Opens whatever the caller
 * opens on right-click; mouse users keep the real contextmenu event.
 *
 * Browsers fire their own `contextmenu` for a touch long press, on their
 * own clock (during the hold on Android, on release on Windows). Left
 * alone it would race our timer and, worse, the fallback menu dismisses
 * itself on any contextmenu event — so the press installs a window-capture
 * guard that swallows it and, if our timer hasn't fired yet, fires now.
 * Whichever comes first wins; the other is a no-op.
 */

export const LONG_PRESS_DELAY_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** The native contextmenu can trail the release; keep the guard up this long. */
const NATIVE_CONTEXT_MENU_GRACE_MS = 400;

export function exceedsLongPressTolerance(
  dx: number,
  dy: number,
  tolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX,
): boolean {
  return dx * dx + dy * dy > tolerancePx * tolerancePx;
}

interface LongPressGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  /** "pending" until fired; "cancelled" once movement or a swipe took over. */
  state: "pending" | "fired" | "cancelled";
  timer: number | null;
}

export interface LongPressPointerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useLongPress(options: {
  readonly enabled: boolean;
  readonly onLongPress: (position: { x: number; y: number }) => void;
}): {
  readonly handlers: LongPressPointerHandlers | undefined;
  /** Abandon the current press (e.g. a swipe started). */
  readonly cancel: () => void;
  /** Call from the row's click handler: true means "swallow this click". */
  readonly consumeSuppressedClick: () => boolean;
} {
  const { enabled } = options;
  const gestureRef = useRef<LongPressGesture | null>(null);
  const suppressorRef = useRef(new GestureClickSuppressor());
  const removeGuardRef = useRef<(() => void) | null>(null);
  const guardTimerRef = useRef<number | null>(null);
  const onLongPressRef = useRef(options.onLongPress);
  onLongPressRef.current = options.onLongPress;

  const clearTimer = useCallback((gesture: LongPressGesture) => {
    if (gesture.timer !== null) {
      window.clearTimeout(gesture.timer);
      gesture.timer = null;
    }
  }, []);

  const fire = useCallback(
    (gesture: LongPressGesture) => {
      if (gesture.state !== "pending") return;
      gesture.state = "fired";
      clearTimer(gesture);
      suppressorRef.current.suppress(performance.now());
      onLongPressRef.current({ x: gesture.x, y: gesture.y });
    },
    [clearTimer],
  );

  const removeGuard = useCallback(() => {
    if (guardTimerRef.current !== null) {
      window.clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
    removeGuardRef.current?.();
    removeGuardRef.current = null;
  }, []);

  const installGuard = useCallback(
    (gesture: LongPressGesture) => {
      removeGuard();
      const onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        fire(gesture);
      };
      window.addEventListener("contextmenu", onContextMenu, true);
      removeGuardRef.current = () => window.removeEventListener("contextmenu", onContextMenu, true);
    },
    [fire, removeGuard],
  );

  const cancel = useCallback(() => {
    const gesture = gestureRef.current;
    if (gesture === null) return;
    clearTimer(gesture);
    if (gesture.state === "pending") gesture.state = "cancelled";
  }, [clearTimer]);

  const release = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      clearTimer(gesture);
      // A release before the delay is a plain tap; the guard stays up only
      // to swallow (and honor) a trailing native contextmenu.
      guardTimerRef.current = window.setTimeout(removeGuard, NATIVE_CONTEXT_MENU_GRACE_MS);
    },
    [clearTimer, removeGuard],
  );

  useEffect(
    () => () => {
      if (gestureRef.current !== null) clearTimer(gestureRef.current);
      removeGuard();
    },
    [clearTimer, removeGuard],
  );

  const handlers = useMemo<LongPressPointerHandlers | undefined>(() => {
    if (!enabled) return undefined;
    return {
      onPointerDown: (event) => {
        if (!isGesturePointer(event.pointerType) || event.button !== 0) return;
        if ((event.target as HTMLElement).closest("input, textarea")) return;
        if (gestureRef.current !== null) clearTimer(gestureRef.current);
        const gesture: LongPressGesture = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: event.clientX,
          y: event.clientY,
          state: "pending",
          timer: null,
        };
        gesture.timer = window.setTimeout(() => fire(gesture), LONG_PRESS_DELAY_MS);
        gestureRef.current = gesture;
        installGuard(gesture);
      },
      onPointerMove: (event) => {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== event.pointerId) return;
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        if (
          gesture.state === "pending" &&
          exceedsLongPressTolerance(event.clientX - gesture.startX, event.clientY - gesture.startY)
        ) {
          cancel();
        }
      },
      onPointerUp: release,
      // pointercancel may be the browser starting its own long-press
      // gesture, so it stops our timer but leaves the press "pending": a
      // native contextmenu arriving in the grace window still opens ours.
      onPointerCancel: release,
    };
  }, [cancel, clearTimer, enabled, fire, installGuard, release]);

  const consumeSuppressedClick = useCallback(
    () => suppressorRef.current.consume(performance.now()),
    [],
  );

  return { handlers, cancel, consumeSuppressedClick };
}
