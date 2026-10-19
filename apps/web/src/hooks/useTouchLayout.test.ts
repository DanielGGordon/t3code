import { describe, expect, it } from "vite-plus/test";

import { resolveTouchLayout } from "./useTouchLayout";

describe("resolveTouchLayout", () => {
  it("turns on for phones unless they opted out", () => {
    expect(resolveTouchLayout({ explicit: false, phoneDefault: true, isPhone: true })).toBe(true);
    expect(resolveTouchLayout({ explicit: false, phoneDefault: false, isPhone: true })).toBe(false);
  });

  it("leaves non-phones alone unless the layout is explicitly on", () => {
    expect(resolveTouchLayout({ explicit: false, phoneDefault: true, isPhone: false })).toBe(false);
    expect(resolveTouchLayout({ explicit: true, phoneDefault: false, isPhone: false })).toBe(true);
  });
});
