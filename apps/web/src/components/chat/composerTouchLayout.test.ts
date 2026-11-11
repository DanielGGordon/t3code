import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerControlsSummary,
  resolveComposerFooterCompactness,
} from "./composerTouchLayout";

describe("buildComposerControlsSummary", () => {
  it("joins model, traits and access", () => {
    expect(
      buildComposerControlsSummary({
        modelLabel: "Opus",
        traitsLabel: "High · 1M",
        runtimeMode: "full-access",
      }),
    ).toBe("Opus · High · 1M · Full");
  });

  it("skips missing parts", () => {
    expect(
      buildComposerControlsSummary({
        traitsLabel: "  ",
        runtimeMode: "approval-required",
      }),
    ).toBe("Supervised");
    expect(
      buildComposerControlsSummary({
        modelLabel: null,
        traitsLabel: "Medium",
        runtimeMode: "auto-accept-edits",
      }),
    ).toBe("Medium · Auto-edits");
  });
});

describe("resolveComposerFooterCompactness", () => {
  it("passes measurements through outside the touch layout", () => {
    expect(
      resolveComposerFooterCompactness({
        touchLayout: false,
        measuredFooterCompact: true,
        measuredPrimaryActionsCompact: true,
      }),
    ).toEqual({ footerCompact: true, primaryActionsCompact: true });
    expect(
      resolveComposerFooterCompactness({
        touchLayout: false,
        measuredFooterCompact: false,
        measuredPrimaryActionsCompact: false,
      }),
    ).toEqual({ footerCompact: false, primaryActionsCompact: false });
  });

  it("always folds controls in the touch layout", () => {
    expect(
      resolveComposerFooterCompactness({
        touchLayout: true,
        measuredFooterCompact: false,
        measuredPrimaryActionsCompact: true,
      }),
    ).toEqual({ footerCompact: true, primaryActionsCompact: false });
  });
});
