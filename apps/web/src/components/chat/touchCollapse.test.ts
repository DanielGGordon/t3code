import { describe, expect, it } from "vite-plus/test";

import {
  countTextLines,
  estimateWrappedLines,
  shouldTouchCollapse,
  TOUCH_COLLAPSE_LINE_LIMIT,
  TOUCH_WRAP_CHARS_PER_LINE,
} from "./touchCollapse";

describe("touch collapse", () => {
  it("counts lines, ignoring a single trailing newline", () => {
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("a")).toBe(1);
    expect(countTextLines("a\nb")).toBe(2);
    expect(countTextLines("a\nb\n")).toBe(2);
    expect(countTextLines("a\n\n")).toBe(2);
  });

  it("collapses only in touch layout and only beyond the limit", () => {
    expect(shouldTouchCollapse({ touchLayout: true, lineCount: TOUCH_COLLAPSE_LINE_LIMIT })).toBe(
      false,
    );
    expect(
      shouldTouchCollapse({ touchLayout: true, lineCount: TOUCH_COLLAPSE_LINE_LIMIT + 1 }),
    ).toBe(true);
    expect(shouldTouchCollapse({ touchLayout: false, lineCount: 500 })).toBe(false);
    expect(shouldTouchCollapse({ touchLayout: true, lineCount: 11, limit: 10 })).toBe(true);
  });

  it("estimates wrapped rows so few-but-long lines still count as tall", () => {
    expect(estimateWrappedLines("")).toBe(0);
    expect(estimateWrappedLines("a\n\nb\n")).toBe(3);
    expect(estimateWrappedLines("x".repeat(10), 4)).toBe(3);
    expect(estimateWrappedLines(`${"x".repeat(8)}\nyy`, 4)).toBe(3);

    const minifiedJson = "x".repeat(TOUCH_WRAP_CHARS_PER_LINE * 50);
    expect(countTextLines(minifiedJson)).toBe(1);
    expect(estimateWrappedLines(minifiedJson)).toBe(50);
    expect(
      shouldTouchCollapse({ touchLayout: true, lineCount: estimateWrappedLines(minifiedJson) }),
    ).toBe(true);

    const shortLines = Array.from({ length: 30 }, () => "short").join("\n");
    expect(estimateWrappedLines(shortLines)).toBe(30);
  });
});
