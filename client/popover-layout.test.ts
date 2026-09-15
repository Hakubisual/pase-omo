import { expect, it } from "vitest";

import { popoverMaxHeight } from "./popover-layout.js";

/**
 * The ceiling has to follow the screen, because the failure it exists to prevent
 * is a popover whose buttons sit below the bottom edge of a phone.
 */

it("keeps a phone popover inside the screen it opens on", () => {
  // A 667pt phone: the old fixed 420 left nothing for the composer or the
  // keyboard, so the last row fell off the bottom.
  expect(popoverMaxHeight(true, 667)).toBeCloseTo(366.85, 2);
  expect(popoverMaxHeight(true, 667)).toBeLessThan(420);
});

it("never shrinks below a usable height on a short screen", () => {
  expect(popoverMaxHeight(true, 320)).toBe(220);
  expect(popoverMaxHeight(false, 320)).toBe(320);
});

it("keeps the desktop ceiling on a tall window", () => {
  expect(popoverMaxHeight(false, 1200)).toBe(520);
  expect(popoverMaxHeight(true, 1200)).toBe(420);
});

it("falls back to the fixed ceiling when the viewport is unknown", () => {
  expect(popoverMaxHeight(true, 0)).toBe(420);
  expect(popoverMaxHeight(false, 0)).toBe(520);
});
