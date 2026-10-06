import { useIsMobile } from "./useMediaQuery";
import { useClientSettings } from "./useSettings";

/**
 * Whether this device is in the touch / car layout (Settings → Features).
 * Use for structural changes; for sizing prefer the `touch:` CSS variant.
 */
export function useTouchLayout(): boolean {
  return useClientSettings((settings) => settings.touchLayout);
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
