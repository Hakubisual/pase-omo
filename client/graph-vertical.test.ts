import { describe, expect, it } from "vitest";
import type { DagChip } from "../shared/row";
import { layoutGraph } from "./graph-layout";

/**
 * A phone is tall, not wide. Laid out left to right, an eight-layer run is over
 * a thousand pixels across: it shrinks to the scale floor and still needs
 * horizontal scrolling, which is how the card ended up unreadable on mobile.
 * Turned on its side the layers run down the screen, where the space is.
 */
const chip = (id: string, state = "pending"): DagChip => ({ id, label: id, state });

const MOBILE = 390;

/** Eight layers, the shape the demo run had. */
const deepChain = {
  layers: [
    [chip("l1"), chip("l2")],
    [chip("l3")],
    [chip("l4")],
    [chip("l5")],
    [chip("l6"), chip("l7")],
    [chip("l8")],
    [chip("l9")],
    [chip("l10")],
  ],
  edges: [
    { from: "l1", to: "l3" },
    { from: "l2", to: "l3" },
    { from: "l3", to: "l4" },
    { from: "l4", to: "l5" },
    { from: "l5", to: "l6" },
    { from: "l5", to: "l7" },
    { from: "l6", to: "l8" },
    { from: "l7", to: "l8" },
    { from: "l8", to: "l9" },
    { from: "l9", to: "l10" },
  ],
};

describe("layoutGraph vertical orientation", () => {
  it("runs the layers down the screen instead of across it", () => {
    const layout = layoutGraph(deepChain, { orientation: "vertical" });

    const first = layout.nodes.filter((node) => node.layer === 0);
    const second = layout.nodes.filter((node) => node.layer === 1);

    // A layer shares one row of the screen...
    expect(new Set(first.map((node) => node.y)).size).toBe(1);
    // ...and the next layer sits BELOW it, not beside it.
    expect(second[0]?.y).toBeGreaterThan(first[0]!.y);
    // Siblings still sit side by side.
    expect(new Set(first.map((node) => node.x)).size).toBe(first.length);
  });

  it("fits an eight-layer run inside a phone without shrinking it", () => {
    const horizontal = layoutGraph(deepChain, undefined, { width: MOBILE });
    const vertical = layoutGraph(deepChain, { orientation: "vertical" }, { width: MOBILE });

    // The old layout could not fit and paid for it with scale.
    expect(horizontal.scale).toBeLessThan(1);
    // The new one fits at full size, which is the whole point.
    expect(vertical.scale).toBe(1);
    for (const node of vertical.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(MOBILE + 0.5);
    }
  });

  it("draws each dependency from the bottom of one node to the top of the next", () => {
    const layout = layoutGraph(
      { layers: [[chip("a")], [chip("b")]], edges: [{ from: "a", to: "b" }] },
      { orientation: "vertical" },
    );

    const from = layout.nodes.find((node) => node.id === "a");
    const to = layout.nodes.find((node) => node.id === "b");
    const edge = layout.edges[0];
    expect(from && to && edge).toBeTruthy();
    if (!from || !to || !edge) return;

    // The segment's centreline lives in the gap between the two nodes.
    expect(edge.y).toBeGreaterThanOrEqual(from.y + from.height);
    expect(edge.y).toBeLessThanOrEqual(to.y);
    // Straight down reads as 90 degrees, never 0.
    expect(Math.abs(edge.angle)).toBeCloseTo(90, 5);
  });

  it("leaves the horizontal layout exactly as it was when nothing asks for vertical", () => {
    const before = layoutGraph(deepChain);
    const explicit = layoutGraph(deepChain, { orientation: "horizontal" });

    expect(explicit.nodes.map((node) => [node.x, node.y])).toEqual(
      before.nodes.map((node) => [node.x, node.y]),
    );
  });
});
