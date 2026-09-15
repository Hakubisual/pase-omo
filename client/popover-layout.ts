/**
 * How tall a composer-pill popover may be, and how much room its last control
 * needs at the bottom.
 *
 * A fixed pixel ceiling is what makes the bottom of a popover unreachable on a
 * phone: 420pt of content anchored above the composer does not fit over a
 * 667pt-tall screen once the composer, the keyboard and the home indicator have
 * taken their share, and the buttons — which is where a popover's answer lives —
 * are the part that falls off. The ceiling is a fraction of the real viewport
 * instead, with a floor so a short landscape screen still shows something
 * usable.
 */

const COMPACT_VIEWPORT_FRACTION = 0.55;
const REGULAR_VIEWPORT_FRACTION = 0.7;
const COMPACT_MIN_HEIGHT = 220;
const COMPACT_MAX_HEIGHT = 420;
const REGULAR_MIN_HEIGHT = 320;
const REGULAR_MAX_HEIGHT = 520;

/** Keeps the last row clear of the home indicator / gesture bar. */
export const POPOVER_BOTTOM_INSET = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function popoverMaxHeight(compact: boolean, windowHeight: number): number {
  // An unmeasured viewport (0, or a host that reports nothing) keeps the old
  // fixed ceiling rather than collapsing the popover to its floor.
  const height = windowHeight > 0 ? windowHeight : Number.POSITIVE_INFINITY;
  if (compact) {
    return clamp(height * COMPACT_VIEWPORT_FRACTION, COMPACT_MIN_HEIGHT, COMPACT_MAX_HEIGHT);
  }
  return clamp(height * REGULAR_VIEWPORT_FRACTION, REGULAR_MIN_HEIGHT, REGULAR_MAX_HEIGHT);
}
