import { useCallback, useSyncExternalStore } from "react";

import { resolveDriveMode } from "~/lib/driveMode";
import { useIsMobile } from "./useMediaQuery";
import { useClientSettings } from "./useSettings";

/**
 * Whether this device is in the touch / car layout (Settings → Features).
 * Use for structural changes; for sizing prefer the `touch:` CSS variant.
 */
export function useTouchLayout(): boolean {
  return useClientSettings((settings) => settings.touchLayout);
}

function subscribeToViewportResize(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

/**
 * Compact "drive" density: the touch layout in a car-sized browser (a Tesla
 * halves the browser while driving). Automatic in both directions as the
 * viewport resizes. For structural changes only; for sizing prefer the
 * `drive:` CSS variant. The snapshot is the resolved boolean, so a resize
 * only re-renders subscribers when the mode actually flips.
 */
export function useDriveMode(): boolean {
  const touchLayout = useTouchLayout();
  const getSnapshot = useCallback(
    () =>
      typeof window === "undefined"
        ? false
        : resolveDriveMode({ touchLayout, viewportWidth: window.innerWidth }),
    [touchLayout],
  );
  return useSyncExternalStore(subscribeToViewportResize, getSnapshot, () => false);
}

/** Keyboard-on-demand is on explicitly or implied by the touch layout. */
export function useComposerKeyboardOnDemand(): boolean {
  return useClientSettings((settings) => settings.composerKeyboardOnDemand || settings.touchLayout);
}

/**
 * Phone viewports and the touch / car layout share one "condensed chrome"
 * treatment: fewer, larger header controls and always-visible usage readouts.
 */
export function resolveCondensedChrome(input: {
  readonly isMobile: boolean;
  readonly touchLayout: boolean;
}): boolean {
  return input.isMobile || input.touchLayout;
}

export function useCondensedChrome(): boolean {
  const isMobile = useIsMobile();
  const touchLayout = useTouchLayout();
  return resolveCondensedChrome({ isMobile, touchLayout });
}
