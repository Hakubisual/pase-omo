import { describe, expect, test } from "vitest";
import type { DagRun, DagTask } from "../shared/dag.js";
import { WORKFLOW_METRICS, curvePieces, flowPath, focusRun, layoutWorkflow, runSubtasks, workflowActivity } from "./workflow-layout.js";

type State = DagRun["nodes"][number]["state"];
const node = (id: string, state: State, taskId?: string) => ({
  id,
  label: id.toUpperCase(),
  state,
  attempt: 0,
  error: "",
  ...(taskId ? { taskId } : {}),
});

const run = {
  nodes: [
    node("plan", "completed", "st_plan"),
    node("a", "completed", "st_a"),
    node("b", "running", "st_b"),
    node("merge", "pending"),
  ],
  edges: [
    { from: "plan", to: "a" },
    { from: "plan", to: "b" },
    { from: "a", to: "merge" },
    { from: "b", to: "merge" },
  ],
};

describe("layoutWorkflow", () => {
  test("puts each wave in its own column, left to right, with per-wave settled counts", () => {
    const layout = layoutWorkflow(run);
    const column = (id: string) => layout.cards.find((card) => card.node.id === id)?.wave;
    expect([column("plan"), column("a"), column("b"), column("merge")]).toEqual([0, 1, 1, 2]);
    expect(layout.waves.map((wave) => [wave.settled, wave.total, wave.running])).toEqual([
      [1, 1, 0],
      [1, 2, 1],
      [0, 1, 0],
    ]);
    const xs = layout.waves.map((wave) => wave.x);
    expect(xs[1]! - xs[0]!).toBe(WORKFLOW_METRICS.cardWidth + WORKFLOW_METRICS.colGap);
    expect(layout.currentWave).toBe(1);
    expect([layout.settled, layout.total]).toEqual([2, 4]);
  });

  test("tones an edge by the work it carries", () => {
    const tones = Object.fromEntries(layoutWorkflow(run).edges.map((edge) => [`${edge.from}>${edge.to}`, edge.tone]));
    expect(tones).toEqual({ "plan>a": "done", "plan>b": "active", "a>merge": "done", "b>merge": "idle" });
  });

  test("centres a narrow run in a wide viewport and never shifts a wide one", () => {
    const natural = layoutWorkflow(run);
    const centred = layoutWorkflow(run, WORKFLOW_METRICS, natural.width + 400);
    expect(centred.waves[0]!.x - natural.waves[0]!.x).toBe(200);
    expect(layoutWorkflow(run, WORKFLOW_METRICS, 100).waves[0]!.x).toBe(natural.waves[0]!.x);
  });

  test("an empty run lays out as nothing", () => {
    expect(layoutWorkflow({ nodes: [], edges: [] })).toMatchObject({ waves: [], cards: [], width: 0, height: 0 });
  });
});

test("curve pieces join end to end from source to target", () => {
  const pieces = curvePieces(0, 0, 100, 40);
  const first = pieces[0]!;
  const last = pieces.at(-1)!;
  const start = { x: first.cx - (Math.cos(first.angle) * first.length) / 2, y: first.cy - (Math.sin(first.angle) * first.length) / 2 };
  const end = { x: last.cx + (Math.cos(last.angle) * last.length) / 2, y: last.cy + (Math.sin(last.angle) * last.length) / 2 };
  expect(start.x).toBeCloseTo(0);
  expect(start.y).toBeCloseTo(0);
  expect(end.x).toBeCloseTo(100);
  expect(end.y).toBeCloseTo(40);
});

test("a flow path runs from the source to the target with strictly increasing stops", () => {
  const path = flowPath(curvePieces(0, 0, 100, 40));
  expect(path.xs[0]).toBeCloseTo(0);
  expect(path.ys[0]).toBeCloseTo(0);
  expect(path.xs.at(-1)).toBeCloseTo(100);
  expect(path.ys.at(-1)).toBeCloseTo(40);
  expect(path.stops[0]).toBe(0);
  expect(path.stops.at(-1)).toBeCloseTo(1);
  for (let i = 1; i < path.stops.length; i += 1) expect(path.stops[i]!).toBeGreaterThan(path.stops[i - 1]!);
  expect([path.xs.length, path.ys.length]).toEqual([path.stops.length, path.stops.length]);
});

describe("focusRun", () => {
  const make = (id: string, status: DagRun["status"], updatedAt: string): DagRun => ({
    id, name: id, status, createdAt: updatedAt, updatedAt, nodes: [], edges: [],
  });
  const done = make("done", "completed", "2026-09-29T03:00:00.000Z");
  const live = make("live", "running", "2026-09-29T01:00:00.000Z");
  const older = make("older", "running", "2026-09-28T01:00:00.000Z");

  test("shows the newest running run over a newer finished one", () => {
    expect(focusRun([done, older, live])?.id).toBe("live");
  });
  test("falls back to the newest run once nothing runs, and honours an explicit pick", () => {
    expect(focusRun([make("a", "failed", "2026-09-01T00:00:00.000Z"), done])?.id).toBe("done");
    expect(focusRun([done, live], "done")?.id).toBe("done");
    expect(focusRun([done, live], "gone")?.id).toBe("live");
    expect(focusRun([])).toBeUndefined();
  });
});

test("subtasks collect every depth under the run's nodes, then run-less tasks, running first", () => {
  const task = (id: string, status: string, startedAt: string): DagTask => ({ id, status, startedAt });
  const children = new Map<string, DagTask[]>([
    ["st_plan", [task("st_child", "completed", "2026-09-29T00:01:00.000Z")]],
    ["st_child", [task("st_grand", "running", "2026-09-29T00:02:00.000Z")]],
    ["st_elsewhere", [task("st_foreign", "running", "2026-09-29T00:09:00.000Z")]],
  ]);
  const standalone = [task("st_solo", "completed", "2026-09-29T00:05:00.000Z")];
  expect(runSubtasks(run, children, standalone).map((entry) => entry.id)).toEqual(["st_grand", "st_solo", "st_child"]);
  expect(runSubtasks(undefined, children, standalone).map((entry) => entry.id)).toEqual(["st_solo"]);
});

test("activity lists starts, ends, errors and live progress newest first", () => {
  const tasks = new Map<string, DagTask>([
    ["st_plan", { id: "st_plan", startedAt: "2026-09-29T00:00:00.000Z", completedAt: "2026-09-29T00:01:00.000Z" }],
    ["st_b", { id: "st_b", startedAt: "2026-09-29T00:02:00.000Z", progress: "checking every claim" }],
  ]);
  const failed = { ...node("plan", "failed", "st_plan"), error: "boom" };
  const now = Date.parse("2026-09-29T00:05:00.000Z");
  const entries = workflowActivity({ nodes: [failed, node("b", "running", "st_b")] }, tasks, now);
  expect(entries.map((entry) => [entry.text, entry.state])).toEqual([
    ["B — checking every claim", null],
    ["B — started", "running"],
    ["PLAN", "failed"],
    ["PLAN — boom", null],
    ["PLAN — started", "running"],
  ]);
});
