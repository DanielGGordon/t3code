import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn() },
  Platform: { OS: "ios" },
}));

import {
  checkForSideloadUpdates,
  isSideloadUpdateAvailable,
  resolveSideloadManifestUrl,
} from "./sideload-updates";

describe("resolveSideloadManifestUrl", () => {
  it("returns the configured manifest URL", () => {
    expect(
      resolveSideloadManifestUrl({ sideloadUpdates: { manifestUrl: " https://x/latest.json " } }),
    ).toBe("https://x/latest.json");
  });

  it("is null when sideload updates are not configured", () => {
    expect(resolveSideloadManifestUrl(undefined)).toBeNull();
    expect(resolveSideloadManifestUrl({})).toBeNull();
    expect(resolveSideloadManifestUrl({ sideloadUpdates: null })).toBeNull();
    expect(resolveSideloadManifestUrl({ sideloadUpdates: { manifestUrl: "" } })).toBeNull();
  });
});

describe("off Android", () => {
  it("is unavailable and the button is a no-op", () => {
    expect(isSideloadUpdateAvailable()).toBe(false);
    expect(() => checkForSideloadUpdates()).not.toThrow();
  });
});
