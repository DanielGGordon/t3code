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
