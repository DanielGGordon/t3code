import { describe, expect, it } from "vite-plus/test";
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
