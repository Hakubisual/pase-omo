import { describe, expect, it } from "vitest";

import { DEFAULT_GRAPH_METRICS, layoutGraph } from "./graph-layout";

const chip = (id: string, state = "pending") => ({ id, label: id.toUpperCase(), state });

const M = DEFAULT_GRAPH_METRICS;

describe("layoutGraph", () => {
  it("places a single node at the padding origin and sizes the canvas around it", () => {
    const layout = layoutGraph({ layers: [[chip("a")]], edges: [] });

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]).toMatchObject({
      id: "a",
      label: "A",
      state: "pending",
      layer: 0,
      row: 0,
      x: M.padding,
      y: M.padding,
      width: M.nodeWidth,
      height: M.nodeHeight,
    });
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(M.padding * 2 + M.nodeWidth);
    expect(layout.height).toBe(M.padding * 2 + M.nodeHeight);
  });

  it("returns an empty canvas for a run with no layers", () => {
    expect(layoutGraph({ layers: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      scale: 1,
    });
  });

  it("centres a short layer against the tallest layer so a fan-out reads symmetrically", () => {
    const layout = layoutGraph({
      layers: [[chip("a")], [chip("b"), chip("c")]],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });

    const pitch = M.nodeHeight + M.rowGap;
    const byId = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));

    // Layer 0 holds one node against a two-node layer, so it sits half a pitch down.
    expect(byId.a?.x).toBe(M.padding);
    expect(byId.a?.y).toBe(M.padding + pitch / 2);

    expect(byId.b?.x).toBe(M.padding + M.nodeWidth + M.layerGap);
    expect(byId.b?.y).toBe(M.padding);
    expect(byId.c?.x).toBe(M.padding + M.nodeWidth + M.layerGap);
    expect(byId.c?.y).toBe(M.padding + pitch);

    expect(layout.width).toBe(M.padding * 2 + M.nodeWidth * 2 + M.layerGap);
    expect(layout.height).toBe(M.padding * 2 + M.nodeHeight * 2 + M.rowGap);
  });

  it("emits one rotated segment per edge, anchored right-centre to left-centre", () => {
    const layout = layoutGraph({
      layers: [[chip("a")], [chip("b"), chip("c")]],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });

    expect(layout.edges).toHaveLength(2);

    const pitch = M.nodeHeight + M.rowGap;
    const startX = M.padding + M.nodeWidth;
    const startY = M.padding + pitch / 2 + M.nodeHeight / 2;
    const endX = M.padding + M.nodeWidth + M.layerGap;
    const upperEndY = M.padding + M.nodeHeight / 2;

    const dx = endX - startX;
    const dy = upperEndY - startY;
    const length = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const up = layout.edges.find((edge) => edge.to === "b");
    expect(up).toBeDefined();
    expect(up?.length).toBeCloseTo(length, 6);
    expect(up?.angle).toBeCloseTo(angle, 6);
    // The segment is drawn as a centre-rotated strip, so its box is offset by half its length.
    expect(up?.x).toBeCloseTo((startX + endX) / 2 - length / 2, 6);
    expect(up?.y).toBeCloseTo((startY + upperEndY) / 2, 6);

    // The mirrored edge leaves at the opposite angle.
    const down = layout.edges.find((edge) => edge.to === "c");
    expect(down?.angle).toBeCloseTo(-angle, 6);
    expect(down?.length).toBeCloseTo(length, 6);
  });

  it("marks an edge fulfilled only when its source node has completed", () => {
    const layout = layoutGraph({
      layers: [[chip("done", "completed"), chip("busy", "running")], [chip("next")]],
      edges: [
        { from: "done", to: "next" },
        { from: "busy", to: "next" },
      ],
    });

    expect(layout.edges.find((edge) => edge.from === "done")?.fulfilled).toBe(true);
    expect(layout.edges.find((edge) => edge.from === "busy")?.fulfilled).toBe(false);
  });

  it("drops edges whose endpoints were truncated away instead of drawing them to nowhere", () => {
    const layout = layoutGraph({
      layers: [[chip("a")], [chip("b")]],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "dropped-by-truncation" },
        { from: "also-dropped", to: "b" },
      ],
    });

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("keeps a self-referential or same-layer edge from producing a zero-length artefact", () => {
    const layout = layoutGraph({
      layers: [[chip("a"), chip("b")]],
      edges: [
        { from: "a", to: "a" },
        { from: "a", to: "b" },
      ],
    });

    expect(layout.edges.every((edge) => edge.length > 0)).toBe(true);
    expect(layout.edges.some((edge) => edge.from === "a" && edge.to === "a")).toBe(false);
  });

  it("honours overridden metrics so a compact card can shrink every dimension", () => {
    const layout = layoutGraph(
      { layers: [[chip("a")], [chip("b")]], edges: [{ from: "a", to: "b" }] },
      { nodeWidth: 100, nodeHeight: 40, layerGap: 16, rowGap: 8, padding: 4 },
    );

    expect(layout.nodes[0]).toMatchObject({ x: 4, y: 4, width: 100, height: 40 });
    expect(layout.nodes[1]).toMatchObject({ x: 4 + 100 + 16, y: 4 });
    expect(layout.width).toBe(4 * 2 + 100 * 2 + 16);
    expect(layout.height).toBe(4 * 2 + 40);
  });
});
