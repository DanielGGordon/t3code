import { describe, expect, it } from "vite-plus/test";

import {
  SWIPE_AXIS_LOCK_SLOP_PX,
  clampSwipeOffset,
  estimateSwipeVelocity,
  resolveSwipeAxis,
  resolveSwipeRelease,
} from "./useSwipeAction";

const both = { allowLeft: true, allowRight: true };

describe("resolveSwipeAxis", () => {
  it("stays pending inside the slop", () => {
    expect(resolveSwipeAxis(SWIPE_AXIS_LOCK_SLOP_PX - 1, 0)).toBe("pending");
    expect(resolveSwipeAxis(-3, 4)).toBe("pending");
  });

  it("locks horizontal only when horizontal clearly dominates", () => {
    expect(resolveSwipeAxis(20, 2)).toBe("horizontal");
    expect(resolveSwipeAxis(-20, 5)).toBe("horizontal");
  });

  it("gives diagonal and vertical movement to scrolling", () => {
    expect(resolveSwipeAxis(2, 20)).toBe("vertical");
    // A 45° drag is ambiguous: scrolling must win, never the swipe.
    expect(resolveSwipeAxis(15, 15)).toBe("vertical");
    expect(resolveSwipeAxis(15, -14)).toBe("vertical");
  });
});

describe("clampSwipeOffset", () => {
  it("pins disallowed directions at zero", () => {
    expect(clampSwipeOffset(-50, { allowLeft: false, allowRight: true, width: 300 })).toBe(0);
    expect(clampSwipeOffset(50, { allowLeft: true, allowRight: false, width: 300 })).toBe(0);
  });

  it("follows the finger up to the row width", () => {
    expect(clampSwipeOffset(-50, { ...both, width: 300 })).toBe(-50);
    expect(clampSwipeOffset(500, { ...both, width: 300 })).toBe(300);
    expect(clampSwipeOffset(-500, { ...both, width: 300 })).toBe(-300);
  });
});

describe("estimateSwipeVelocity", () => {
  it("measures over the trailing window only", () => {
    expect(
      estimateSwipeVelocity([
        { x: 0, t: 0 },
        { x: 10, t: 400 },
        { x: 60, t: 450 },
        { x: 110, t: 500 },
      ]),
    ).toBeCloseTo(1);
  });

  it("is zero without enough history", () => {
    expect(estimateSwipeVelocity([])).toBe(0);
    expect(estimateSwipeVelocity([{ x: 5, t: 10 }])).toBe(0);
  });
});

describe("resolveSwipeRelease", () => {
  const width = 300;

  it("commits past 35% of the row width", () => {
    expect(resolveSwipeRelease({ ...both, offset: -110, width, velocity: 0 })).toBe("left");
    expect(resolveSwipeRelease({ ...both, offset: 110, width, velocity: 0 })).toBe("right");
  });

  it("springs back below the threshold at rest", () => {
    expect(resolveSwipeRelease({ ...both, offset: -90, width, velocity: 0 })).toBeNull();
    expect(resolveSwipeRelease({ ...both, offset: 0, width, velocity: 2 })).toBeNull();
  });

  it("commits a fast flick in the swipe's direction", () => {
    expect(resolveSwipeRelease({ ...both, offset: 40, width, velocity: 0.8 })).toBe("right");
    expect(resolveSwipeRelease({ ...both, offset: -40, width, velocity: -0.8 })).toBe("left");
  });

  it("ignores twitches and flicks back toward rest", () => {
    expect(resolveSwipeRelease({ ...both, offset: 20, width, velocity: 2 })).toBeNull();
    expect(resolveSwipeRelease({ ...both, offset: 80, width, velocity: -1 })).toBeNull();
  });

  it("never commits a disallowed direction", () => {
    expect(
      resolveSwipeRelease({ allowLeft: false, allowRight: true, offset: -200, width, velocity: 0 }),
    ).toBeNull();
    expect(
      resolveSwipeRelease({ allowLeft: true, allowRight: false, offset: 200, width, velocity: 0 }),
    ).toBeNull();
  });
});
