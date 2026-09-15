import { describe, expect, it } from "vitest";

import { COMPACT_GRAPH_METRICS, layoutGraph } from "./graph-layout";
import { fitsStateLine, graphTypography } from "./graph-visual";

/**
 * A graph that fits its box is worth nothing when the labels inside it do not
 * survive the fit. The card scales its geometry to the viewport, so the type
 * and the node content have to answer to that same scale: type stops shrinking
 * at a readable floor, and a node too short for two lines drops the line the
 * colour already tells you.
 */

const chip = (id: string) => ({ id, label: id, state: "pending" });

describe("graphTypography", () => {
  it("draws base sizes when nothing was scaled", () => {
    expect(graphTypography(1, true)).toEqual({ glyph: 11, label: 12, state: 10 });
    expect(graphTypography(1, false)).toEqual({ glyph: 12, label: 13, state: 11 });
  });

  it("stops shrinking at the readable floor instead of following the scale down", () => {
    // 12 * 0.4 is 5pt of label: the floor is what keeps a fitted graph readable.
    expect(graphTypography(0.4, true)).toEqual({ glyph: 9, label: 10, state: 9 });
  });

  it("never grows as the scale falls", () => {
    let previous = graphTypography(1, true);
    for (const scale of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const next = graphTypography(scale, true);
      expect(next.label).toBeLessThanOrEqual(previous.label);
      expect(next.glyph).toBeLessThanOrEqual(previous.glyph);
      expect(next.state).toBeLessThanOrEqual(previous.state);
      previous = next;
    }
  });
});

describe("fitsStateLine", () => {
  it("keeps the state line on a node drawn at full size", () => {
    expect(fitsStateLine(48, graphTypography(1, true))).toBe(true);
  });

  it("drops it once the box is shorter than the two lines it would hold", () => {
    // The same 48pt node scaled to the compact floor is 28pt tall, and floored
    // type no longer fits twice inside it.
    expect(fitsStateLine(48 * 0.58, graphTypography(0.58, true))).toBe(false);
  });
});

describe("compact graph on a phone-width card", () => {
  /** Inner width of a chat card on a 360pt phone, once the card's padding is off. */
  const PHONE_CARD = 320;

  it("fits a four-wide fan-out without scrolling", () => {
    const layers = [
      [chip("a1"), chip("a2"), chip("a3"), chip("a4")],
      [chip("b1"), chip("b2")],
      [chip("c")],
    ];

    const layout = layoutGraph({ layers, edges: [] }, COMPACT_GRAPH_METRICS, { width: PHONE_CARD });

    expect(layout.scale).toBeGreaterThan(COMPACT_GRAPH_METRICS.minScale);
    // Exactly the card: a canvas wider than its box is what makes the card scroll.
    expect(layout.width).toBeCloseTo(PHONE_CARD, 5);
  });

  it("keeps a two-wide run at full size", () => {
    const layers = [[chip("a"), chip("b")], [chip("c")]];

    const layout = layoutGraph({ layers, edges: [] }, COMPACT_GRAPH_METRICS, { width: PHONE_CARD });

    expect(layout.scale).toBe(1);
  });

  it("stops at the floor and scrolls once a run is too wide to stay readable", () => {
    const layers = [["a", "b", "c", "d", "e", "f"].map(chip)];

    const layout = layoutGraph({ layers, edges: [] }, COMPACT_GRAPH_METRICS, { width: PHONE_CARD });

    expect(layout.scale).toBeCloseTo(COMPACT_GRAPH_METRICS.minScale, 5);
    expect(layout.width).toBeGreaterThan(PHONE_CARD);
  });
});
