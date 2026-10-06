import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveCondensedChrome } from "~/hooks/useTouchLayout";
import { resolveHeaderControlVisibility, shouldShowOpenInPicker } from "./ChatHeader";

describe("resolveHeaderControlVisibility", () => {
  it("auto shows the control on desktop", () => {
    expect(resolveHeaderControlVisibility("auto", false)).toBe(true);
  });

  it("auto hides the control on mobile", () => {
    expect(resolveHeaderControlVisibility("auto", true)).toBe(false);
  });

  it("show overrides the mobile default", () => {
    expect(resolveHeaderControlVisibility("show", true)).toBe(true);
  });

  it("hide overrides the desktop default", () => {
    expect(resolveHeaderControlVisibility("hide", false)).toBe(false);
  });

  it("auto hides the control in the touch layout on a wide screen", () => {
    const condensed = resolveCondensedChrome({ isMobile: false, touchLayout: true });
    expect(resolveHeaderControlVisibility("auto", condensed)).toBe(false);
    expect(resolveHeaderControlVisibility("show", condensed)).toBe(true);
  });
});

describe("resolveCondensedChrome", () => {
  it("is condensed on phones and in the touch layout only", () => {
    expect(resolveCondensedChrome({ isMobile: false, touchLayout: false })).toBe(false);
    expect(resolveCondensedChrome({ isMobile: true, touchLayout: false })).toBe(true);
    expect(resolveCondensedChrome({ isMobile: false, touchLayout: true })).toBe(true);
    expect(resolveCondensedChrome({ isMobile: true, touchLayout: true })).toBe(true);
  });
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});
