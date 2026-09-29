import type { DagRun, DagTask } from "../shared/dag.js";

type Node = DagRun["nodes"][number];
type Edge = DagRun["edges"][number];

const SETTLED = new Set(["completed", "failed", "cancelled", "skipped"]);

export function isSettled(state: string): boolean {
  return SETTLED.has(state);
}

export interface WorkflowMetrics {
  cardWidth: number;
  cardHeight: number;
  colGap: number;
  rowGap: number;
  headerHeight: number;
  padding: number;
}

export const WORKFLOW_METRICS: WorkflowMetrics = {
  cardWidth: 188,
  cardHeight: 80,
  colGap: 44,
  rowGap: 12,
  headerHeight: 28,
  padding: 16,
};

export const COMPACT_WORKFLOW_METRICS: WorkflowMetrics = {
  cardWidth: 156,
  cardHeight: 80,
  colGap: 28,
  rowGap: 10,
  headerHeight: 28,
  padding: 8,
};

export interface WaveSummary {
  index: number;
  total: number;
  settled: number;
  running: number;
  x: number;
}

export interface WorkflowCard {
  node: Node;
  wave: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CurvePiece {
  cx: number;
  cy: number;
  length: number;
  angle: number;
}

export type EdgeTone = "done" | "active" | "failed" | "idle";

export interface WorkflowEdge {
  from: string;
  to: string;
  tone: EdgeTone;
  pieces: CurvePiece[];
  path: FlowPath;
}

export interface WorkflowLayout {
  waves: WaveSummary[];
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
  width: number;
  height: number;
  currentWave: number;
  settled: number;
  total: number;
}

/** Longest-path wave per node; a cycle (which a valid run never has) falls back to wave 0. */
export function waveOf(nodes: Node[], edges: Edge[]): Map<string, number> {
  const ups = new Map<string, string[]>();
  for (const edge of edges) ups.set(edge.to, [...(ups.get(edge.to) ?? []), edge.from]);
  const waves = new Map<string, number>();
  const visit = (id: string, trail: Set<string>): number => {
    const known = waves.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    let wave = 0;
    for (const up of ups.get(id) ?? []) wave = Math.max(wave, visit(up, trail) + 1);
    trail.delete(id);
    waves.set(id, wave);
    return wave;
  };
  for (const node of nodes) visit(node.id, new Set());
  return waves;
}

function edgeTone(from: Node | undefined, to: Node | undefined): EdgeTone {
  if (to?.state === "running") return "active";
  if (from?.state === "failed") return "failed";
  if (from?.state === "completed") return "done";
  return "idle";
}

export function curvePieces(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  steps = 12,
): CurvePiece[] {
  const bend = Math.max(12, (x2 - x1) / 2);
  const point = (t: number) => {
    const u = 1 - t;
    // Cubic Bezier with both control points pulled horizontally.
    const x = u * u * u * x1 + 3 * u * u * t * (x1 + bend) + 3 * u * t * t * (x2 - bend) + t * t * t * x2;
    const y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
    return { x, y };
  };
  const pieces: CurvePiece[] = [];
  let previous = point(0);
  for (let step = 1; step <= steps; step += 1) {
    const next = point(step / steps);
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    pieces.push({
      cx: (previous.x + next.x) / 2,
      cy: (previous.y + next.y) / 2,
      length: Math.hypot(dx, dy),
      angle: Math.atan2(dy, dx),
    });
    previous = next;
  }
  return pieces;
}

export interface FlowPath {
  xs: number[];
  ys: number[];
  /** Strictly increasing 0..1 distance stops, one per point, for `interpolate`. */
  stops: number[];
  length: number;
}

export function flowPath(pieces: CurvePiece[]): FlowPath {
  const xs: number[] = [];
  const ys: number[] = [];
  const distances: number[] = [];
  let travelled = 0;
  for (const piece of pieces) {
    const dx = (Math.cos(piece.angle) * piece.length) / 2;
    const dy = (Math.sin(piece.angle) * piece.length) / 2;
    if (xs.length === 0) {
      xs.push(piece.cx - dx);
      ys.push(piece.cy - dy);
      distances.push(0);
    }
    if (piece.length <= 0) continue;
    travelled += piece.length;
    xs.push(piece.cx + dx);
    ys.push(piece.cy + dy);
    distances.push(travelled);
  }
  const stops = distances.map((distance) => (travelled > 0 ? distance / travelled : 0));
  return { xs, ys, stops, length: travelled };
}

const LIVE = new Set(["running", "scheduled", "paused", "blocked", "pending"]);

/** The run the board shows: the newest one still moving, otherwise the newest one. */
export function focusRun(runs: DagRun[], preferredId: string | null = null): DagRun | undefined {
  const preferred = preferredId === null ? undefined : runs.find((run) => run.id === preferredId);
  if (preferred) return preferred;
  const newest = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  return newest.find((run) => run.status === "running") ?? newest.find((run) => LIVE.has(run.status)) ?? newest[0];
}

/**
 * Tasks for the side drawer: everything spawned beneath the run's own node
 * tasks (at any depth), then the session's tasks that belong to no run.
 * Running work sorts first, then the most recently started.
 */
export function runSubtasks(
  run: Pick<DagRun, "nodes"> | undefined,
  childTasksMap: Map<string, DagTask[]>,
  standalone: DagTask[],
): DagTask[] {
  const seen = new Set<string>();
  const found: DagTask[] = [];
  const pending = (run?.nodes ?? []).map((node) => node.taskId).filter((id): id is string => id !== undefined);
  while (pending.length > 0) {
    const parent = pending.shift() as string;
    for (const child of childTasksMap.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      pending.push(child.id);
    }
  }
  for (const task of standalone) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      found.push(task);
    }
  }
  const running = (task: DagTask) => (task.status === "running" ? 1 : 0);
  return found.sort((a, b) => running(b) - running(a) || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export function layoutWorkflow(
  run: Pick<DagRun, "nodes" | "edges">,
  metrics: WorkflowMetrics = WORKFLOW_METRICS,
  viewportWidth = 0,
): WorkflowLayout {
  const { cardWidth, cardHeight, colGap, rowGap, headerHeight, padding } = metrics;
  const waveById = waveOf(run.nodes, run.edges);
  const waveCount = run.nodes.length === 0 ? 0 : Math.max(...waveById.values()) + 1;

  // Order each column by where its upstream cards sit, so edges cross less.
  const ups = new Map<string, string[]>();
  for (const edge of run.edges) ups.set(edge.to, [...(ups.get(edge.to) ?? []), edge.from]);
  const rowById = new Map<string, number>();
  const columns: Node[][] = Array.from({ length: waveCount }, () => []);
  for (const node of run.nodes) columns[waveById.get(node.id) ?? 0]?.push(node);
  columns.forEach((column, wave) => {
    if (wave > 0) {
      const weight = (node: Node) => {
        const rows = (ups.get(node.id) ?? []).map((id) => rowById.get(id) ?? 0);
        return rows.length === 0 ? Number.MAX_SAFE_INTEGER : rows.reduce((a, b) => a + b, 0) / rows.length;
      };
      const original = new Map(column.map((node, index) => [node.id, index]));
      column.sort((a, b) => weight(a) - weight(b) || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0));
    }
    column.forEach((node, row) => rowById.set(node.id, row));
  });

  const naturalWidth = waveCount === 0 ? 0 : padding * 2 + waveCount * cardWidth + (waveCount - 1) * colGap;
  const offsetX = viewportWidth > naturalWidth ? Math.floor((viewportWidth - naturalWidth) / 2) : 0;
  const tallest = Math.max(0, ...columns.map((column) => column.length));
  const height = waveCount === 0 ? 0 : padding * 2 + headerHeight + tallest * cardHeight + Math.max(0, tallest - 1) * rowGap;

  const cards: WorkflowCard[] = [];
  const waves: WaveSummary[] = columns.map((column, index) => {
    const x = offsetX + padding + index * (cardWidth + colGap);
    column.forEach((node, row) => {
      cards.push({
        node,
        wave: index,
        x,
        y: padding + headerHeight + row * (cardHeight + rowGap),
        width: cardWidth,
        height: cardHeight,
      });
    });
    return {
      index,
      total: column.length,
      settled: column.filter((node) => isSettled(node.state)).length,
      running: column.filter((node) => node.state === "running").length,
      x,
    };
  });

  const cardById = new Map(cards.map((card) => [card.node.id, card]));
  const edges: WorkflowEdge[] = [];
  for (const edge of run.edges) {
    const from = cardById.get(edge.from);
    const to = cardById.get(edge.to);
    if (!from || !to) continue;
    const pieces = curvePieces(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2);
    edges.push({ from: edge.from, to: edge.to, tone: edgeTone(from.node, to.node), pieces, path: flowPath(pieces) });
  }

  const open = waves.findIndex((wave) => wave.settled < wave.total);
  return {
    waves,
    cards,
    edges,
    width: offsetX + naturalWidth,
    height,
    currentWave: open === -1 ? Math.max(0, waveCount - 1) : open,
    settled: run.nodes.filter((node) => isSettled(node.state)).length,
    total: run.nodes.length,
  };
}

export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function taskElapsed(task: DagTask | undefined, now: number): number | undefined {
  if (!task?.startedAt) return undefined;
  const start = Date.parse(task.startedAt);
  const end = task.completedAt ? Date.parse(task.completedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface ActivityEntry {
  key: string;
  at: number;
  nodeId: string;
  state: string | null;
  text: string;
}

export function workflowActivity(
  run: Pick<DagRun, "nodes">,
  tasks: Map<string, DagTask>,
  now: number,
  limit = 40,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const node of run.nodes) {
    const task = node.taskId ? tasks.get(node.taskId) : undefined;
    const started = task?.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    const ended = task?.completedAt ? Date.parse(task.completedAt) : Number.NaN;
    if (Number.isFinite(started)) {
      entries.push({ key: `${node.id}:start`, at: started, nodeId: node.id, state: "running", text: `${node.label} — started` });
    }
    if (isSettled(node.state) && Number.isFinite(ended)) {
      entries.push({ key: `${node.id}:end`, at: ended, nodeId: node.id, state: node.state, text: node.label });
      if (node.error) {
        entries.push({ key: `${node.id}:error`, at: ended, nodeId: node.id, state: null, text: `${node.label} — ${node.error}` });
      }
    }
    if (node.state === "running" && task?.progress) {
      entries.push({ key: `${node.id}:progress`, at: now, nodeId: node.id, state: null, text: `${node.label} — ${task.progress}` });
    }
  }
  return entries.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)).slice(0, limit);
}
