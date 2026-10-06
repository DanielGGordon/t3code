import type { HeaderControlVisibility } from "@t3tools/contracts/settings";

/** Resolves a Settings -> Features show/hide/auto toggle; "auto" hides on mobile. */
export function resolveHeaderControlVisibility(
  visibility: HeaderControlVisibility,
  isMobile: boolean,
): boolean {
  if (visibility === "auto") {
    return !isMobile;
  }
  return visibility === "show";
}
