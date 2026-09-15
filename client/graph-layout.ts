import type { DagChip } from "../shared/row";
import { READABLE_MIN_SCALE } from "./graph-visual";

/**
 * Geometry for one DAG card. Every dimension is a prop rather than a constant so
 * the compact chat row and the roomy workspace panel can share one layout pass.
 */
/**
 * Which way the dependency layers run.
 *
 * A phone is tall, not wide: laid out left to right an eight-layer run is over
 * a thousand pixels across, so it shrinks to the scale floor and still needs
 * horizontal scrolling. Turned on its side the layers run down the screen,
 * where the space actually is.
 */
export type GraphOrientation = "horizontal" | "vertical";

export type GraphMetrics = {
  nodeWidth: number;
  nodeHeight: number;
  /** Gap between one layer and the next, along the flow direction. */
  layerGap: number;
  /** Gap between siblings inside a layer, across the flow direction. */
  rowGap: number;
  padding: number;
  orientation: GraphOrientation;
  /**
   * How far the graph may shrink to fit its box before it stops shrinking and
   * scrolls instead.
   *
   * This is a READABILITY floor, not a geometry one: past it the node boxes are
   * too short to hold a line of type, so a wide run is better read by scrolling
   * a legible graph than by staring at a legible-sized font clipped inside a
   * box half its height.
   */
  minScale: number;
};

export const DEFAULT_GRAPH_METRICS: GraphMetrics = {
  nodeWidth: 140,
  nodeHeight: 56,
  layerGap: 28,
  rowGap: 12,
  padding: 8,
  orientation: "horizontal",
  minScale: 0.5,
};

/**
 * Geometry for the compact card the chat row and the composer pill draw.
 *
 * A phone is tall, not wide, so the flow runs down the screen and the node box
 * is narrower than the panel's: width is what a fan-out spends, and four
 * siblings at the panel's node width would scale the whole graph past the point
 * where its labels survive. At this width a four-wide run fits a phone-sized
 * card outright instead of asking to be scrolled.
 */
export const COMPACT_GRAPH_METRICS: GraphMetrics = {
  nodeWidth: 120,
  nodeHeight: 48,
  layerGap: 16,
  rowGap: 8,
  padding: 6,
  orientation: "vertical",
  minScale: READABLE_MIN_SCALE,
};

export type GraphNode = {
  id: string;
  label: string;
  state: string;
  layer: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * One dependency arrow, pre-solved for a renderer that has no line primitive.
 *
 * React Native cannot draw a diagonal, so the card draws each edge as a thin
 * horizontal strip rotated about its own centre. `length` and `angle` are that
 * strip's size and rotation; `x` is the strip's LEFT edge once centre-rotation
 * is accounted for, and `y` is the segment's CENTRELINE — the renderer offsets
 * it by half the stroke thickness it chooses, which the layout deliberately
 * does not know.
 */
export type GraphEdge = {
  from: string;
  to: string;
  x: number;
  y: number;
  length: number;
  angle: number;
  /** True when the SOURCE node completed, which is what makes a dependency satisfied. */
  fulfilled: boolean;
};

export type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /**
   * Factor the natural geometry was multiplied by to fit the viewport, 1 when
   * nothing was scaled. The renderer needs it for font sizing, which cannot ride
   * along on a transform without becoming unreadable.
   */
  scale: number;
};

export type GraphInput = {
  layers: DagChip[][];
  edges: { from: string; to: string }[];
};

/**
 * The box the graph is drawn into, when the caller knows it.
 *
 * Height is optional because a chat row grows to its content while a panel is
 * bounded, and only a bounded box can centre vertically.
 */
export type GraphViewport = {
  width: number;
  height?: number;
};

const EMPTY: GraphLayout = { nodes: [], edges: [], width: 0, height: 0, scale: 1 };

/**
 * Turns dependency layers into positioned nodes and drawable dependency arrows.
 *
 * Layers run left to right and each layer stacks downward, but a short layer is
 * CENTRED against the tallest one: a single root feeding three children then
 * sits level with the middle child and its arrows fan out symmetrically, which
 * is the difference between a graph that reads as a graph and one that reads as
 * a ragged list.
 */
export function layoutGraph(
  input: GraphInput,
  metrics?: Partial<GraphMetrics>,
  viewport?: GraphViewport,
): GraphLayout {
  const m: GraphMetrics = { ...DEFAULT_GRAPH_METRICS, ...metrics };

  // A layer that truncation emptied would otherwise reserve a blank column.
  const layers = input.layers.filter((layer) => layer.length > 0);
  if (layers.length === 0) {
    // An empty run still owns its box, so the card draws an empty canvas of the
    // right size instead of collapsing to nothing.
    return viewport === undefined
      ? EMPTY
      : { nodes: [], edges: [], width: viewport.width, height: viewport.height ?? 0, scale: 1 };
  }

  const vertical = m.orientation === "vertical";
  // Along the flow, layers advance by the layer pitch; across it, siblings
  // advance by the sibling pitch. Which axis is which is the only difference
  // between the two orientations.
  const layerPitch = (vertical ? m.nodeHeight : m.nodeWidth) + m.layerGap;
  const siblingPitch = (vertical ? m.nodeWidth : m.nodeHeight) + m.rowGap;
  const maxRows = layers.reduce((tallest, layer) => Math.max(tallest, layer.length), 0);

  const nodes: GraphNode[] = [];
  for (const [layerIndex, layer] of layers.entries()) {
    // Centre this layer's stack inside the tallest layer's band.
    const offset = ((maxRows - layer.length) * siblingPitch) / 2;
    for (const [rowIndex, node] of layer.entries()) {
      const alongFlow = m.padding + layerIndex * layerPitch;
      const acrossFlow = m.padding + offset + rowIndex * siblingPitch;
      nodes.push({
        id: node.id,
        label: node.label,
        state: node.state,
        layer: layerIndex,
        row: rowIndex,
        x: vertical ? acrossFlow : alongFlow,
        y: vertical ? alongFlow : acrossFlow,
        width: m.nodeWidth,
        height: m.nodeHeight,
      });
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edges: GraphEdge[] = [];
  for (const edge of input.edges) {
    // A truncated run keeps edges whose other end was dropped; drawing those
    // would point an arrow at empty canvas.
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || from === to) continue;

    // The arrow leaves the trailing edge of the source and lands on the leading
    // edge of the target, which is the bottom and the top once the flow is
    // vertical.
    const startX = vertical ? from.x + from.width / 2 : from.x + from.width;
    const startY = vertical ? from.y + from.height : from.y + from.height / 2;
    const endX = vertical ? to.x + to.width / 2 : to.x;
    const endY = vertical ? to.y : to.y + to.height / 2;

    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;

    edges.push({
      from: edge.from,
      to: edge.to,
      x: (startX + endX) / 2 - length / 2,
      y: (startY + endY) / 2,
      length,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      fulfilled: from.state === "completed",
    });
  }

  const alongSpan = layers.length * (vertical ? m.nodeHeight : m.nodeWidth) + (layers.length - 1) * m.layerGap;
  const acrossSpan = maxRows * (vertical ? m.nodeWidth : m.nodeHeight) + (maxRows - 1) * m.rowGap;
  const contentWidth = m.padding * 2 + (vertical ? acrossSpan : alongSpan);
  const contentHeight = m.padding * 2 + (vertical ? alongSpan : acrossSpan);

  if (viewport === undefined) {
    return { nodes, edges, width: contentWidth, height: contentHeight, scale: 1 };
  }

  return fitToViewport({ nodes, edges, contentWidth, contentHeight }, viewport, m.minScale);
}

/**
 * Scales the natural geometry down until it fits the viewport width, then
 * centres what is left in both axes.
 *
 * Centring happens here rather than in the renderer because every node is
 * positioned absolutely from these coordinates: a canvas centred with styling
 * would still hold its nodes against its left edge.
 */
function fitToViewport(
  natural: { nodes: GraphNode[]; edges: GraphEdge[]; contentWidth: number; contentHeight: number },
  viewport: GraphViewport,
  minScale: number,
): GraphLayout {
  const { contentWidth, contentHeight } = natural;
  const scale =
    contentWidth <= viewport.width ? 1 : Math.max(minScale, viewport.width / contentWidth);

  const scaledWidth = contentWidth * scale;
  const scaledHeight = contentHeight * scale;
  const width = Math.max(viewport.width, scaledWidth);
  const height = Math.max(viewport.height ?? scaledHeight, scaledHeight);
  const offsetX = (width - scaledWidth) / 2;
  const offsetY = (height - scaledHeight) / 2;

  const nodes = natural.nodes.map((node) => ({
    ...node,
    x: node.x * scale + offsetX,
    y: node.y * scale + offsetY,
    width: node.width * scale,
    height: node.height * scale,
  }));

  const edges = natural.edges.map((edge) => ({
    ...edge,
    // `x` is the strip's left edge and `y` its centreline, so both ride the same
    // transform the nodes do; the angle is scale-invariant.
    x: edge.x * scale + offsetX,
    y: edge.y * scale + offsetY,
    length: edge.length * scale,
  }));

  return { nodes, edges, width, height, scale };
}
