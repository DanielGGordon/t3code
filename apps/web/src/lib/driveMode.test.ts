import { describe, expect, it } from "vite-plus/test";

import { DRIVE_MODE_MAX_VIEWPORT_WIDTH, resolveDriveMode } from "./driveMode";

describe("resolveDriveMode", () => {
  it("is on for the touch layout in a car-sized (drive) browser", () => {
    expect(resolveDriveMode({ touchLayout: true, viewportWidth: 650 })).toBe(true);
    expect(resolveDriveMode({ touchLayout: true, viewportWidth: 800 })).toBe(true);
  });

  it("is off for the touch layout at parked size", () => {
    expect(resolveDriveMode({ touchLayout: true, viewportWidth: 1200 })).toBe(false);
    expect(resolveDriveMode({ touchLayout: true, viewportWidth: 1920 })).toBe(false);
  });

  it("flips exactly at the threshold so a resize toggles it both ways", () => {
    expect(
      resolveDriveMode({ touchLayout: true, viewportWidth: DRIVE_MODE_MAX_VIEWPORT_WIDTH - 1 }),
    ).toBe(true);
    expect(
      resolveDriveMode({ touchLayout: true, viewportWidth: DRIVE_MODE_MAX_VIEWPORT_WIDTH }),
    ).toBe(false);
  });

  it("never engages outside the touch layout, however small the viewport", () => {
    expect(resolveDriveMode({ touchLayout: false, viewportWidth: 390 })).toBe(false);
    expect(resolveDriveMode({ touchLayout: false, viewportWidth: 700 })).toBe(false);
  });
});
