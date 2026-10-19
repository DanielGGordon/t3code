/**
 * Viewport width below which the touch / car layout switches to its compact
 * "drive" density. A Tesla shrinks the browser to roughly half the screen
 * while driving (about 650–800 CSS px wide) and gives it the full ~1200px+
 * when parked, so the `lg` breakpoint sits between the two with margin on
 * either side. Height is ignored: it barely differs between the two states.
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
