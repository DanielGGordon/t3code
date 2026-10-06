import { describe, expect, it } from "vite-plus/test";

import {
  GESTURE_CLICK_SUPPRESSION_MS,
  GestureClickSuppressor,
  composePointerHandlers,
  isGesturePointer,
} from "./touchGestures";
import { exceedsLongPressTolerance, LONG_PRESS_MOVE_TOLERANCE_PX } from "./useLongPress";

describe("GestureClickSuppressor", () => {
  it("swallows exactly one click inside the window", () => {
    const suppressor = new GestureClickSuppressor();
    suppressor.suppress(1_000);
    expect(suppressor.consume(1_100)).toBe(true);
    expect(suppressor.consume(1_150)).toBe(false);
  });

  it("expires so a missing click can't eat the next real tap", () => {
    const suppressor = new GestureClickSuppressor();
    suppressor.suppress(1_000);
    expect(suppressor.consume(1_000 + GESTURE_CLICK_SUPPRESSION_MS + 1)).toBe(false);
  });

  it("does nothing until a gesture suppresses", () => {
    expect(new GestureClickSuppressor().consume(0)).toBe(false);
  });
});

describe("isGesturePointer", () => {
  it("accepts touch and pen, leaves the mouse alone", () => {
    expect(isGesturePointer("touch")).toBe(true);
    expect(isGesturePointer("pen")).toBe(true);
    expect(isGesturePointer("mouse")).toBe(false);
  });
});

describe("composePointerHandlers", () => {
  const recorder = (log: string[], name: string) => ({
    onPointerDown: () => log.push(`${name}:down`),
    onPointerMove: () => log.push(`${name}:move`),
    onPointerUp: () => log.push(`${name}:up`),
    onPointerCancel: () => log.push(`${name}:cancel`),
  });

  it("is undefined when every recognizer is inert", () => {
    expect(composePointerHandlers(undefined, undefined)).toBeUndefined();
  });

  it("fans each event out to every active recognizer in order", () => {
    const log: string[] = [];
    const handlers = composePointerHandlers(recorder(log, "a"), undefined, recorder(log, "b"));
    handlers?.onPointerDown(null);
    handlers?.onPointerCancel(null);
    expect(log).toEqual(["a:down", "b:down", "a:cancel", "b:cancel"]);
  });
});

describe("exceedsLongPressTolerance", () => {
  it("tolerates finger jitter within the radius", () => {
    expect(exceedsLongPressTolerance(6, 6)).toBe(false);
    expect(exceedsLongPressTolerance(LONG_PRESS_MOVE_TOLERANCE_PX, 0)).toBe(false);
  });

  it("cancels once the finger travels past it", () => {
    expect(exceedsLongPressTolerance(8, 8)).toBe(true);
    expect(exceedsLongPressTolerance(0, -11)).toBe(true);
  });
});
