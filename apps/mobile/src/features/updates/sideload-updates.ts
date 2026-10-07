import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

// In-app updates for the self-hosted sideload build (Android `preview` variant).
// Backed by the vendored android-sideload updater in modules/t3-sideload-updater;
// the manifest URL comes from `extra.sideloadUpdates.manifestUrl` (app.config.ts),
// which is only set for sideload builds. Everywhere else every call is a no-op.

interface SideloadUpdaterModule {
  readonly checkForUpdates: (manifestUrl: string) => boolean;
  readonly checkOnLaunch: (manifestUrl: string) => boolean;
}

export function resolveSideloadManifestUrl(extra: unknown): string | null {
  const config = (extra as { sideloadUpdates?: { manifestUrl?: unknown } } | null | undefined)
    ?.sideloadUpdates;
  const url = typeof config?.manifestUrl === "string" ? config.manifestUrl.trim() : "";
  return url.length > 0 ? url : null;
}

function resolveSideloadUpdater(): { module: SideloadUpdaterModule; manifestUrl: string } | null {
  if (Platform.OS !== "android") return null;
  const manifestUrl = resolveSideloadManifestUrl(Constants.expoConfig?.extra);
  if (manifestUrl === null) return null;
  const module = requireOptionalNativeModule<SideloadUpdaterModule>("T3SideloadUpdater");
  return module === null ? null : { module, manifestUrl };
}

export function isSideloadUpdateAvailable(): boolean {
  return resolveSideloadUpdater() !== null;
}

/** The "Check for updates" button: the native updater shows its own dialogs. */
export function checkForSideloadUpdates(): void {
  const updater = resolveSideloadUpdater();
  updater?.module.checkForUpdates(updater.manifestUrl);
}

/** Quiet check on launch and each foreground; the native side limits it to once per 6 hours. */
export function useSideloadUpdateCheckOnForeground(): void {
  useEffect(() => {
    const updater = resolveSideloadUpdater();
    if (updater === null) return;
    const check = () => {
      updater.module.checkOnLaunch(updater.manifestUrl);
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => subscription.remove();
  }, []);
}
