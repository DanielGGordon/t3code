import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { GestureClickSuppressor, isGesturePointer } from "./touchGestures";

/**
 * Horizontal swipe-to-act for list rows (touch layout). Pure resolvers
 * below carry the thresholds so they are unit-testable; the hook only wires
 * pointer events to them.
 *
 * The row must set `touch-action: pan-y`: the browser keeps vertical
 * panning (and sends pointercancel when it starts scrolling), while
 * horizontal movement is delivered to us.
 */

export type SwipeDirection = "left" | "right";
export type SwipeAxis = "pending" | "horizontal" | "vertical";

/** Movement before the gesture commits to an axis. */
export const SWIPE_AXIS_LOCK_SLOP_PX = 10;
/** Horizontal must dominate by this factor; ties go to scrolling. */
const SWIPE_HORIZONTAL_DOMINANCE = 1.2;
/** Fraction of the row width that commits on release. */
export const SWIPE_COMMIT_RATIO = 0.35;
/** A flick commits early when it is at least this fast... */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.5;
/** ...and has travelled at least this far (a twitch is not a flick). */
export const SWIPE_FLICK_MIN_DISTANCE_PX = 32;
/** Velocity is measured over this trailing window. */
const SWIPE_VELOCITY_WINDOW_MS = 100;

export interface SwipeAllowance {
  readonly allowLeft: boolean;
  readonly allowRight: boolean;
}

export function resolveSwipeAxis(
  dx: number,
  dy: number,
  slopPx = SWIPE_AXIS_LOCK_SLOP_PX,
): SwipeAxis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < slopPx) return "pending";
  return Math.abs(dx) > Math.abs(dy) * SWIPE_HORIZONTAL_DOMINANCE ? "horizontal" : "vertical";
}

/** Disallowed directions don't move at all; allowed ones stop at the edge. */
export function clampSwipeOffset(
  dx: number,
  options: SwipeAllowance & { readonly width: number },
): number {
  if (dx < 0 && !options.allowLeft) return 0;
  if (dx > 0 && !options.allowRight) return 0;
  return Math.max(-options.width, Math.min(options.width, dx));
}

export interface SwipeSample {
  readonly x: number;
  readonly t: number;
}

/** px/ms over the trailing window; 0 with too little history. */
export function estimateSwipeVelocity(samples: ReadonlyArray<SwipeSample>): number {
  const last = samples.at(-1);
  if (last === undefined) return 0;
  const first =
    samples.find((sample) => last.t - sample.t <= SWIPE_VELOCITY_WINDOW_MS) ?? samples[0]!;
  const dt = last.t - first.t;
  return dt <= 0 ? 0 : (last.x - first.x) / dt;
}

export function resolveSwipeRelease(
  input: SwipeAllowance & {
    readonly offset: number;
    readonly width: number;
    readonly velocity: number;
  },
): SwipeDirection | null {
  const direction: SwipeDirection | null =
    input.offset < 0 ? "left" : input.offset > 0 ? "right" : null;
  if (direction === null) return null;
  if (direction === "left" ? !input.allowLeft : !input.allowRight) return null;
  const distance = Math.abs(input.offset);
  if (input.width > 0 && distance >= input.width * SWIPE_COMMIT_RATIO) return direction;
  const isFlick =
    distance >= SWIPE_FLICK_MIN_DISTANCE_PX &&
    Math.sign(input.velocity) === Math.sign(input.offset) &&
    Math.abs(input.velocity) >= SWIPE_FLICK_VELOCITY_PX_PER_MS;
  return isFlick ? direction : null;
}

interface SwipeGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  axis: SwipeAxis;
  offset: number;
  samples: SwipeSample[];
}

export interface SwipePointerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useSwipeAction(
  options: SwipeAllowance & {
    readonly enabled: boolean;
    readonly onCommit: (direction: SwipeDirection) => void;
    /** Fires once when the gesture locks horizontal (cancel long press, etc.). */
    readonly onSwipeStart?: () => void;
  },
): {
  /** Current row translation in px (negative = swiping left). */
  readonly offset: number;
  /** True while the finger is down and driving the offset (no transition). */
  readonly dragging: boolean;
  /** Past the distance threshold: releasing now commits. */
  readonly armed: boolean;
  readonly handlers: SwipePointerHandlers | undefined;
  /** Abandon the current gesture without committing (e.g. a long press fired). */
  readonly cancel: () => void;
  /** Call from the row's click handler: true means "swallow this click". */
  readonly consumeSuppressedClick: () => boolean;
} {
  const { enabled, allowLeft, allowRight } = options;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const suppressorRef = useRef(new GestureClickSuppressor());
  // Latest callbacks without re-binding handlers on every parent render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);
  useEffect(() => cancelFrame, [cancelFrame]);

  const finish = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      cancelFrame();
      setDragging(false);
      setOffset(0);
      if (gesture === null || gesture.axis !== "horizontal") return;
      suppressorRef.current.suppress(performance.now());
      if (!commit) return;
      const direction = resolveSwipeRelease({
        offset: gesture.offset,
        width: gesture.width,
        velocity: estimateSwipeVelocity(gesture.samples),
        allowLeft: optionsRef.current.allowLeft,
        allowRight: optionsRef.current.allowRight,
      });
      if (direction !== null) optionsRef.current.onCommit(direction);
    },
    [cancelFrame],
  );

  const handlers = useMemo<SwipePointerHandlers | undefined>(() => {
    if (!enabled || (!allowLeft && !allowRight)) return undefined;
    return {
      onPointerDown: (event) => {
        if (!isGesturePointer(event.pointerType) || event.button !== 0) return;
        if (gestureRef.current !== null) return;
        if ((event.target as HTMLElement).closest("input, textarea")) return;
        gestureRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          width: event.currentTarget.getBoundingClientRect().width,
          axis: "pending",
          offset: 0,
          samples: [{ x: event.clientX, t: event.timeStamp }],
        };
      },
      onPointerMove: (event) => {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== event.pointerId) return;
        const dx = event.clientX - gesture.startX;
        if (gesture.axis === "pending") {
          gesture.axis = resolveSwipeAxis(dx, event.clientY - gesture.startY);
          if (gesture.axis === "vertical") {
            // Scrolling wins for the rest of this gesture.
            gestureRef.current = null;
            return;
          }
          if (gesture.axis === "pending") return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          setWidth(gesture.width);
          optionsRef.current.onSwipeStart?.();
        }
        gesture.offset = clampSwipeOffset(dx, {
          allowLeft: optionsRef.current.allowLeft,
          allowRight: optionsRef.current.allowRight,
          width: gesture.width,
        });
        gesture.samples.push({ x: event.clientX, t: event.timeStamp });
        if (gesture.samples.length > 8) gesture.samples.shift();
        // Coalesce to one render per frame: pointermove can outpace paint.
        if (frameRef.current === null) {
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            setOffset(gestureRef.current?.offset ?? 0);
          });
        }
      },
      onPointerUp: (event) => {
        if (gestureRef.current?.pointerId !== event.pointerId) return;
        finish(true);
      },
      onPointerCancel: (event) => {
        if (gestureRef.current?.pointerId !== event.pointerId) return;
        finish(false);
      },
    };
  }, [allowLeft, allowRight, enabled, finish]);

  // Turning the feature off mid-gesture must not strand a translated row.
  useEffect(() => {
    if (handlers === undefined && gestureRef.current !== null) finish(false);
  }, [finish, handlers]);

  const consumeSuppressedClick = useCallback(
    () => suppressorRef.current.consume(performance.now()),
    [],
  );
  const cancel = useCallback(() => {
    if (gestureRef.current !== null) finish(false);
  }, [finish]);

  const armed = width > 0 && Math.abs(offset) >= width * SWIPE_COMMIT_RATIO;
  return { offset, dragging, armed, handlers, cancel, consumeSuppressedClick };
}
