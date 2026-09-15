import { describe, expect, it } from "vitest";
import { computeGraphLayout, type DagEdge, type DagNode } from "./dag.js";
import { READABLE_MIN_SCALE } from "./graph-visual.js";

/**
 * The panel draws the workflow graph on an absolutely positioned canvas sized
 * to its own content, so a graph narrower than the panel sat against the left
 * edge while the rest of the panel stayed empty. The layout owns the centring:
 * styling cannot move nodes that carry their own coordinates.
 */

const node = (id: string, state: DagNode["state"] = "pending"): DagNode => ({
  id,
  label: id,
  state,
  attempt: 0,
  error: "",
});

describe("computeGraphLayout viewport centring", () => {
  it("centres the whole graph inside a viewport wider than its content", () => {
    const nodes: DagNode[] = [node("a"), node("b")];
    const edges: DagEdge[] = [{ from: "a", to: "b" }];

    const natural = computeGraphLayout(nodes, edges);
    const centred = computeGraphLayout(nodes, edges, { viewportWidth: 1200 });

    expect(centred.canvasWidth).toBe(1200);
    const left = Math.min(...centred.nodes.map((item) => item.x));
    const right = Math.max(...centred.nodes.map((item) => item.x + item.width));
    expect(Math.abs(left - (1200 - right))).toBeLessThanOrEqual(1);
    // The shift is uniform: the graph moved, it was not re-laid out.
    const shift = (centred.nodes[0]?.x ?? 0) - (natural.nodes[0]?.x ?? 0);
    for (const [index, item] of centred.nodes.entries()) {
      expect(item.x - (natural.nodes[index]?.x ?? 0)).toBeCloseTo(shift, 5);
      expect(item.y).toBe(natural.nodes[index]?.y);
    }
  });

  it("moves the dependency arrows with the nodes", () => {
    const nodes: DagNode[] = [node("a"), node("b")];
    const edges: DagEdge[] = [{ from: "a", to: "b" }];

    const natural = computeGraphLayout(nodes, edges);
    const centred = computeGraphLayout(nodes, edges, { viewportWidth: 1200 });
    const shift = (centred.nodes[0]?.x ?? 0) - (natural.nodes[0]?.x ?? 0);

    const naturalEdge = natural.edges[0];
    const centredEdge = centred.edges[0];
    expect(naturalEdge).toBeDefined();
    expect(centredEdge).toBeDefined();
    if (!naturalEdge || !centredEdge) return;

    expect(centredEdge.arrow.x - naturalEdge.arrow.x).toBeCloseTo(shift, 5);
    for (const [index, segment] of centredEdge.segments.entries()) {
      expect(segment.x - (naturalEdge.segments[index]?.x ?? 0)).toBeCloseTo(shift, 5);
    }
  });

  it("leaves a graph wider than the viewport alone so it can still scroll", () => {
    const nodes: DagNode[] = [node("a"), node("b"), node("c")];
    const natural = computeGraphLayout(nodes, []);
    const narrow = computeGraphLayout(nodes, [], { viewportWidth: 200 });

    expect(narrow.canvasWidth).toBe(natural.canvasWidth);
    expect(narrow.nodes.map((item) => item.x)).toEqual(natural.nodes.map((item) => item.x));
  });

  it("leaves a wide panel unscaled, since it never asks for a floor", () => {
    const nodes: DagNode[] = [node("a"), node("b"), node("c"), node("d")];

    expect(computeGraphLayout(nodes, [], { viewportWidth: 300 }).scale).toBe(1);
  });

  it("keeps an empty graph empty", () => {
    expect(computeGraphLayout([], [], { viewportWidth: 800 })).toEqual({
      nodes: [],
      edges: [],
      canvasWidth: 0,
      canvasHeight: 0,
      scale: 1,
    });
  });
});

/**
 * The phone shows the same canvas the desktop does, which only works when the
 * fit is bounded from both ends: small enough to see the whole run, never so
 * small that a node stops being readable or tappable.
 */
describe("computeGraphLayout compact fit", () => {
  /** What the panel passes on a phone. */
  const COMPACT = {
    nodeWidth: 124,
    nodeHeight: 76,
    colGap: 12,
    rowGap: 22,
    padding: 8,
    minScale: READABLE_MIN_SCALE,
  };
  /** Panel width inside a 390pt phone. */
  const PHONE = 358;

  it("fits a four-wide fan-out on a phone and keeps a legal touch target", () => {
    const nodes: DagNode[] = [node("a"), node("b"), node("c"), node("d")];

    const layout = computeGraphLayout(nodes, [], { ...COMPACT, viewportWidth: PHONE });

    expect(layout.scale).toBeGreaterThan(READABLE_MIN_SCALE);
    expect(layout.canvasWidth).toBeLessThanOrEqual(PHONE);
    for (const item of layout.nodes) expect(item.height).toBeGreaterThanOrEqual(44);
  });

  it("stops at the readable floor and scrolls, still tappable", () => {
    const nodes: DagNode[] = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => node(id));

    const layout = computeGraphLayout(nodes, [], { ...COMPACT, viewportWidth: PHONE });

    expect(layout.scale).toBeCloseTo(READABLE_MIN_SCALE, 5);
    expect(layout.canvasWidth).toBeGreaterThan(PHONE);
    // 76 * 0.58 is what keeps the node a 44pt target at the floor.
    for (const item of layout.nodes) expect(item.height).toBeGreaterThanOrEqual(44);
  });

  it("moves the arrows with the geometry it shrank", () => {
    const nodes: DagNode[] = [node("a"), node("b"), node("c"), node("d"), node("e")];
    const edges: DagEdge[] = [{ from: "a", to: "b" }];

    const layout = computeGraphLayout(nodes, edges, { ...COMPACT, viewportWidth: PHONE });
    const edge = layout.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;
    for (const segment of edge.segments) {
      expect(segment.x).toBeLessThanOrEqual(layout.canvasWidth);
      expect(segment.y).toBeLessThanOrEqual(layout.canvasHeight);
    }
  });
});
