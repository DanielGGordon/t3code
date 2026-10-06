/**
 * Touch / car layout: long code blocks and diffs in the timeline collapse
 * behind a large "Expand" button instead of forcing a long finger scroll.
 */
export const TOUCH_COLLAPSE_LINE_LIMIT = 40;

export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  let lines = 1;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * Conservative characters-per-row for wrapped timeline text in the touch
 * layout (13-17px mono in a ~900px column fits ~90-110). Erring low means a
 * borderline block collapses rather than growing unbounded.
 */
export const TOUCH_WRAP_CHARS_PER_LINE = 80;

/**
 * Visual row estimate once long lines wrap: minified JSON or a one-line log
 * dump has few newlines but can still be thousands of pixels tall.
 */
export function estimateWrappedLines(
  text: string,
  charsPerLine: number = TOUCH_WRAP_CHARS_PER_LINE,
): number {
  if (text.length === 0) {
    return 0;
  }
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const width = Math.max(1, Math.floor(charsPerLine));
  let rows = 0;
  let lineStart = 0;
  for (let index = 0; index <= trimmed.length; index += 1) {
    if (index === trimmed.length || trimmed.charCodeAt(index) === 10) {
      rows += Math.max(1, Math.ceil((index - lineStart) / width));
      lineStart = index + 1;
    }
  }
  return rows;
}

export function shouldTouchCollapse(input: {
  readonly touchLayout: boolean;
  /** Visual rows, i.e. `estimateWrappedLines`, not just newline count. */
  readonly lineCount: number;
  readonly limit?: number;
}): boolean {
  return input.touchLayout && input.lineCount > (input.limit ?? TOUCH_COLLAPSE_LINE_LIMIT);
}
