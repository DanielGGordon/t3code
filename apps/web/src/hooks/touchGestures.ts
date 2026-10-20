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

/** Travel (px) both fingers must share, vertically, before a swipe counts. */
export const TWO_FINGER_SWIPE_MIN_TRAVEL_PX = 80;
/** Sideways drift allowed per pixel of vertical travel. */
const TWO_FINGER_SWIPE_MAX_DRIFT_RATIO = 0.6;

export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Classifies a two-finger drag from each finger's start and end point.
 * Both fingers must travel the same vertical way (opposite ways is a pinch)
 * and mostly straight, so scrolling, zooming and diagonal flicks stay inert.
 */
export function classifyTwoFingerSwipe(
  start: readonly [TouchPoint, TouchPoint],
  end: readonly [TouchPoint, TouchPoint],
): "up" | "down" | null {
  const dy0 = end[0].y - start[0].y;
  const dy1 = end[1].y - start[1].y;
  if (Math.sign(dy0) !== Math.sign(dy1)) return null;
  const dy = (dy0 + dy1) / 2;
  const dx = (end[0].x - start[0].x + end[1].x - start[1].x) / 2;
  if (Math.min(Math.abs(dy0), Math.abs(dy1)) < TWO_FINGER_SWIPE_MIN_TRAVEL_PX) return null;
  if (Math.abs(dx) > Math.abs(dy) * TWO_FINGER_SWIPE_MAX_DRIFT_RATIO) return null;
  return dy < 0 ? "up" : "down";
}

/** Longest a multi-finger touch may stay down and still count as a tap. */
export const MULTI_FINGER_TAP_MAX_DURATION_MS = 350;
/** Longest pause between taps of a repeated tap. */
export const MULTI_FINGER_TAP_MAX_GAP_MS = 500;
/** Travel (px) any finger may drift before the touch stops being a tap. */
export const MULTI_FINGER_TAP_MAX_TRAVEL_PX = 24;

/**
 * Counts consecutive taps: a tap that arrives within `maxGapMs` of the
 * previous one extends the run, a later one starts over. `register` returns
 * true on the tap that completes the run and begins a fresh one.
 */
export class RepeatedTapCounter {
  private count = 0;
  private lastTapMs: number | null = null;

  constructor(
    private readonly taps: number,
    private readonly maxGapMs = MULTI_FINGER_TAP_MAX_GAP_MS,
  ) {}

  register(nowMs: number): boolean {
    this.count =
      this.lastTapMs !== null && nowMs - this.lastTapMs <= this.maxGapMs ? this.count + 1 : 1;
    this.lastTapMs = nowMs;
    if (this.count < this.taps) return false;
    this.reset();
    return true;
  }

  reset(): void {
    this.count = 0;
    this.lastTapMs = null;
  }
}
