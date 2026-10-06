import { describe, expect, it } from "vite-plus/test";
import { resolveCondensedChrome } from "~/hooks/useTouchLayout";
import { resolveHeaderControlVisibility } from "~/lib/headerControlVisibility";
import { resolveRenameCommit } from "./ChatHeader";

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

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
