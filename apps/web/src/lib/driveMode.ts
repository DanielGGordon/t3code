/**
 * Viewport width below which the touch / car layout switches to its compact
 * "drive" density. A Tesla shrinks the browser to roughly half the screen
 * while driving (about 650–800 CSS px wide) and gives it the full ~1200px+
 * when parked, so the `lg` breakpoint sits between the two with margin on
 * either side. Height is ignored: it barely differs between the two states.
 */
export const DRIVE_MODE_MAX_VIEWPORT_WIDTH = 1024;

/**
 * Drive density is automatic: it needs the touch layout to be on (Settings →
 * Features) and a car-sized viewport. Phones never enter it on their own.
 */
export function resolveDriveMode(input: {
  readonly touchLayout: boolean;
  readonly viewportWidth: number;
}): boolean {
  return input.touchLayout && input.viewportWidth < DRIVE_MODE_MAX_VIEWPORT_WIDTH;
}
