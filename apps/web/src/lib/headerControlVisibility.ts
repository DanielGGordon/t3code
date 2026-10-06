import type { HeaderControlVisibility } from "@t3tools/contracts/settings";

/**
 * Resolves a Settings -> Features show/hide/auto toggle; "auto" hides on
 * condensed chrome (phones and the touch / car layout).
 */
export function resolveHeaderControlVisibility(
  visibility: HeaderControlVisibility,
  condensed: boolean,
): boolean {
  if (visibility === "auto") {
    return !condensed;
  }
  return visibility === "show";
}
