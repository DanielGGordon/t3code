import { useCallback, useSyncExternalStore } from "react";

import { resolveDriveMode } from "~/lib/driveMode";
import { useIsMobile, useMediaQuery } from "./useMediaQuery";
import { useClientSettings } from "./useSettings";

/** A finger-driven phone viewport: narrow and touch-primary. */
export const PHONE_MEDIA_QUERY = "(max-width: 767px) and (pointer: coarse)";

/**
 * The touch / car layout is on when the device opted in (Settings → Features)
 * or is a phone that has not opted out. Phones get the same bigger targets
 * and gestures as a car display without touching a setting.
 */
export function resolveTouchLayout(input: {
  readonly explicit: boolean;
  readonly phoneDefault: boolean;
  readonly isPhone: boolean;
}): boolean {
  return input.explicit || (input.phoneDefault && input.isPhone);
}

/** Non-hook read for one-shot initializers; prefer `useTouchLayout`. */
export function readTouchLayout(settings: {
  readonly touchLayout: boolean;
  readonly touchLayoutOnPhones: boolean;
}): boolean {
  return resolveTouchLayout({
    explicit: settings.touchLayout,
    phoneDefault: settings.touchLayoutOnPhones,
    isPhone: typeof window !== "undefined" && window.matchMedia(PHONE_MEDIA_QUERY).matches,
  });
}

/**
 * Whether this device is in the touch / car layout. Use for structural
 * changes; for sizing prefer the `touch:` CSS variant.
 */
export function useTouchLayout(): boolean {
  const explicit = useClientSettings((settings) => settings.touchLayout);
  const phoneDefault = useClientSettings((settings) => settings.touchLayoutOnPhones);
  const isPhone = useMediaQuery(PHONE_MEDIA_QUERY);
  return resolveTouchLayout({ explicit, phoneDefault, isPhone });
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
  // Explicit opt-in only: a phone's default touch layout never turns into
  // the car's compact density.
  const touchLayout = useClientSettings((settings) => settings.touchLayout);
  const getSnapshot = useCallback(
    () =>
      typeof window === "undefined"
        ? false
        : resolveDriveMode({ touchLayout, viewportWidth: window.innerWidth }),
    [touchLayout],
  );
  return useSyncExternalStore(subscribeToViewportResize, getSnapshot, () => false);
}

/**
 * Keyboard-on-demand is on explicitly or implied by the explicit touch / car
 * layout. A phone's default touch layout does not imply it: phones type.
 */
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
