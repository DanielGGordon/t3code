/**
 * Viewport width below which the touch / car layout switches to its compact
 * "drive" density. Measured on a 2023 Model Y (devicePixelRatio 1.53, panel
 * 1920×1200): driving shrinks the browser to a card 773×601 CSS px (1.29:1,
 * ~62% of the screen width); parked it is 1256×706 (16:9). Both lose ~66 CSS
 * px to the URL bar. The `lg` breakpoint sits between the two with margin on
 * either side. Height is ignored here, but a drive layout must fit 601 px.
 */
export const DRIVE_MODE_MAX_VIEWPORT_WIDTH = 1024;

/**
 * Viewport width below which the browser is a phone, not a car: phones keep
 * their own phone presentation even with the touch layout switched on, so
 * the car's compact header never squeezes a phone-sized one. A drive-sized
 * Tesla browser (about 650px and up) stays above it.
 */
export const DRIVE_MODE_MIN_VIEWPORT_WIDTH = 640;

/**
 * Drive density is automatic: it needs the touch layout to be on (Settings →
 * Features) and a car-sized viewport. Phones never enter it.
 */
export function resolveDriveMode(input: {
  readonly touchLayout: boolean;
  readonly viewportWidth: number;
}): boolean {
  return (
    input.touchLayout &&
    input.viewportWidth >= DRIVE_MODE_MIN_VIEWPORT_WIDTH &&
    input.viewportWidth < DRIVE_MODE_MAX_VIEWPORT_WIDTH
  );
}
