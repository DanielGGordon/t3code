import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerControlsSummary,
  formatComposerInteractionModeLabel,
  resolveComposerFooterCompactness,
} from "./composerTouchLayout";

describe("buildComposerControlsSummary", () => {
  it("joins model, traits, access and mode", () => {
    expect(
      buildComposerControlsSummary({
        modelLabel: "Opus",
        traitsLabel: "High · 1M",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBe("Opus · High · 1M · Full · Build");
  });

  it("skips missing parts", () => {
    expect(
      buildComposerControlsSummary({
        traitsLabel: "  ",
        runtimeMode: "approval-required",
        interactionMode: null,
      }),
    ).toBe("Supervised");
    expect(
      buildComposerControlsSummary({
        modelLabel: null,
        traitsLabel: "Medium",
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      }),
    ).toBe("Medium · Auto-edits · Plan");
  });
});

describe("formatComposerInteractionModeLabel", () => {
  it("names the default mode Build", () => {
    expect(formatComposerInteractionModeLabel("default")).toBe("Build");
    expect(formatComposerInteractionModeLabel("plan")).toBe("Plan");
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
