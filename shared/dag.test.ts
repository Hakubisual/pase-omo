import { describe, expect, it } from "vitest";
import { DagRunSchema, DagSessionSchema, DagTaskSchema } from "./dag.js";

/**
 * C3 - the single merged schema must accept everything both original copies
 * accepted. `paseo-omo` carried an optional session `title` that
 * `paseo-dag-plugin` lacked, so the union keeps it optional.
 */
const task = {
  id: "st_01a0a03a",
  description: "analyze",
  agent: "lane-omo",
  model: "z-ai/glm-5.3-flash",
  status: "running",
  turns: 3,
  toolCalls: 12,
};

const run = {
  id: "run_1",
  name: "Docs refresh",
  status: "running" as const,
  createdAt: "2026-09-14T14:00:00.000Z",
  updatedAt: "2026-09-14T14:05:00.000Z",
  nodes: [{ id: "audit", label: "Audit", state: "completed" as const, attempt: 1, taskId: "st_01a0a03a", error: "" }],
  edges: [{ from: "audit", to: "rewrite" }],
};

const session = {
  id: "sess_1",
  cwd: "E:/DEV/FREE",
  createdAt: "2026-09-14T14:00:00.000Z",
  updatedAt: "2026-09-14T14:05:00.000Z",
  taskCount: 4,
  runCount: 1,
};

describe("unified DAG schema", () => {
  it("accepts a task id in the st_ form and rejects one that is not", () => {
    expect(DagTaskSchema.safeParse(task).success).toBe(true);
    expect(DagTaskSchema.safeParse({ ...task, id: "not-a-task-id" }).success).toBe(false);
  });

  it("accepts a run with empty nodes and edges", () => {
    expect(DagRunSchema.safeParse({ ...run, nodes: [], edges: [] }).success).toBe(true);
  });

  it("rejects a run whose status is outside the known set", () => {
    expect(DagRunSchema.safeParse({ ...run, status: "exploded" }).success).toBe(false);
  });

  it("rejects a node with a negative attempt count", () => {
    expect(DagRunSchema.safeParse({ ...run, nodes: [{ ...run.nodes[0], attempt: -1 }] }).success).toBe(false);
  });

  it("accepts a session with and without the optional title", () => {
    expect(DagSessionSchema.safeParse(session).success).toBe(true);
    const titled = DagSessionSchema.safeParse({ ...session, title: "Merge run" });
    expect(titled.success).toBe(true);
    expect(titled.success && (titled.data as { title?: string }).title).toBe("Merge run");
  });

  it("rejects a session with a negative task count", () => {
    expect(DagSessionSchema.safeParse({ ...session, taskCount: -1 }).success).toBe(false);
  });
});
