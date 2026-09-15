import { describe, expect, it } from "vitest";
import type { DagChip } from "../shared/row";
import { DEFAULT_GRAPH_METRICS, layoutGraph } from "./graph-layout";

/**
 * The graph must read as a graph on every screen it lands on: centred inside
 * whatever box it is given, and never wider than a phone viewport.
 *
 * These assertions are about the LAYOUT, not the renderer: the card positions
 * absolutely from these numbers, so a layout that leaves content left-anchored
 * cannot be centred by styling later.
 */

const chip = (id: string, state = "pending"): DagChip => ({ id, label: id, state });

const MOBILE = 390;

describe("layoutGraph centring", () => {
  it("centres a single node inside the viewport it is given", () => {
    const layout = layoutGraph({ layers: [[chip("only")]], edges: [] }, undefined, {
      width: MOBILE,
      height: 600,
    });

    const node = layout.nodes[0];
    expect(node).toBeDefined();
    if (!node) return;

    const left = node.x;
    const right = node.x + node.width;
    // Equal gutters on both sides is what "centred" means, within a pixel of
    // rounding.
    expect(Math.abs(left - (MOBILE - right))).toBeLessThanOrEqual(1);
    expect(Math.abs(node.y - (600 - (node.y + node.height)))).toBeLessThanOrEqual(1);
    expect(layout.width).toBe(MOBILE);
    expect(layout.height).toBe(600);
  });

  it("centres an unbalanced tree as one block rather than per column", () => {
    const layout = layoutGraph(
      {
        layers: [[chip("root")], [chip("a"), chip("b"), chip("c")]],
        edges: [
          { from: "root", to: "a" },
          { from: "root", to: "b" },
          { from: "root", to: "c" },
        ],
      },
      undefined,
      { width: 1000, height: 500 },
    );

    const xs = layout.nodes.map((n) => n.x);
    const rights = layout.nodes.map((n) => n.x + n.width);
    const ys = layout.nodes.map((n) => n.y);
    const bottoms = layout.nodes.map((n) => n.y + n.height);

    const leftGutter = Math.min(...xs);
    const rightGutter = 1000 - Math.max(...rights);
    const topGutter = Math.min(...ys);
    const bottomGutter = 500 - Math.max(...bottoms);

    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);
    expect(Math.abs(topGutter - bottomGutter)).toBeLessThanOrEqual(1);
  });

  it("keeps every node inside a 390px phone viewport by scaling the graph down", () => {
    // Four layers at the default metrics are far wider than a phone.
    const wide = {
      layers: [[chip("l1")], [chip("l2")], [chip("l3")], [chip("l4")]],
      edges: [
        { from: "l1", to: "l2" },
        { from: "l2", to: "l3" },
        { from: "l3", to: "l4" },
      ],
    };
    const natural = layoutGraph(wide, undefined);
    expect(natural.width).toBeGreaterThan(MOBILE);

    const layout = layoutGraph(wide, undefined, { width: MOBILE, height: 400 });

    expect(layout.scale).toBeLessThan(1);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(MOBILE + 0.5);
    }
    // Shrinking past legibility is worse than scrolling, so the layout keeps a
    // floor and reports it honestly.
    expect(layout.scale).toBeGreaterThanOrEqual(0.5);
  });

  it("reports an empty graph as an empty viewport-sized canvas instead of NaN", () => {
    const layout = layoutGraph({ layers: [], edges: [] }, undefined, { width: MOBILE, height: 200 });

    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(MOBILE);
    expect(layout.height).toBe(200);
    expect(layout.scale).toBe(1);
  });

  it("leaves the natural layout untouched when no viewport is supplied", () => {
    const input = { layers: [[chip("a")], [chip("b")]], edges: [{ from: "a", to: "b" }] };
    const layout = layoutGraph(input, undefined);

    expect(layout.scale).toBe(1);
    expect(layout.nodes[0]?.x).toBe(DEFAULT_GRAPH_METRICS.padding);
  });
});
