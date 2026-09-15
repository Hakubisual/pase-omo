/**
 * Ported from paseo-dag-plugin/client/dag.test.tsx. The pure DAG view helpers it
 * covers are unchanged by the merge, so this is regression coverage for them.
 *
 * Its final "Plugin Contribution Registration" block is deliberately NOT ported:
 * it asserted the pre-merge manifest (exactly one panel, one command item, and
 * sidebar id "dag-sidebar"). The unified entry registers two panels, three command
 * items and sidebar id "omo-dag", so that block describes a shape this plugin is
 * meant not to have. test/contributions.test.ts asserts the same underlying claim
 * more strictly: the union of all four originals' contributions, no duplicate ids,
 * and every registration handle released on cleanup.
 */
import { describe, expect, it } from "vitest";

import {
  buildDependencyMaps,
  calculateSessionStats,
  computeDagLayers,
  computeGraphLayout,
  computeTaskHierarchy,
  formatDuration,
  formatKoreanDateTime,
  getStatusColor,
  getStatusGlyph,
  getStatusLabel,
  isNodeExpanded,
  isRunExpanded,
  isTaskExpanded,
  toggleNodeExpanded,
  toggleRunExpanded,
  toggleTaskExpanded,
  type DagEdge,
  type DagNode,
} from "./dag.js";
import type { DagRun, DagSnapshotPayload, DagTask } from "../shared/dag.js";
import type { PluginTheme } from "@getpaseo/plugin";

const mockTheme: PluginTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f8f9fa",
    surface2: "#f1f3f5",
    border: "#dee2e6",
    foreground: "#212529",
    foregroundMuted: "#868e96",
    accent: "#0284c7",
    accentForeground: "#ffffff",
    statusSuccess: "#16a34a",
    statusWarning: "#ca8a04",
    statusDanger: "#dc2626",
  },
};

describe("Status semantic mapping & tokens", () => {
  it("returns non-empty labels and glyphs for all valid statuses", () => {
    const statuses = [
      "running",
      "completed",
      "failed",
      "error",
      "blocked",
      "scheduled",
      "pending",
      "paused",
      "cancelled",
      "skipped",
      "interrupted",
      "lost",
      undefined,
    ];

    for (const status of statuses) {
      expect(typeof getStatusLabel(status)).toBe("string");
      expect(getStatusLabel(status).length).toBeGreaterThan(0);

      expect(typeof getStatusGlyph(status)).toBe("string");
      expect(getStatusGlyph(status).length).toBeGreaterThan(0);
    }
  });

  it("uses theme colors strictly with no hardcoded fallbacks", () => {
    expect(getStatusColor("running", mockTheme)).toBe(mockTheme.colors.accent);
    expect(getStatusColor("completed", mockTheme)).toBe(mockTheme.colors.statusSuccess);
    expect(getStatusColor("failed", mockTheme)).toBe(mockTheme.colors.statusDanger);
    expect(getStatusColor("error", mockTheme)).toBe(mockTheme.colors.statusDanger);
    expect(getStatusColor("blocked", mockTheme)).toBe(mockTheme.colors.statusWarning);
    expect(getStatusColor("pending", mockTheme)).toBe(mockTheme.colors.foregroundMuted);
    expect(getStatusColor("unknown", mockTheme)).toBe(mockTheme.colors.foregroundMuted);
  });
});

describe("DateTime and Duration formatters", () => {
  it("formats ISO timestamps to Korean datetime format", () => {
    const formatted = formatKoreanDateTime("2026-09-10T13:45:20.000Z");
    expect(formatted).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
    expect(formatKoreanDateTime(undefined)).toBe("-");
    expect(formatKoreanDateTime("invalid-date")).toBe("invalid-date");
  });

  it("formats elapsed duration cleanly across second, minute, and hour boundaries", () => {
    const start = "2026-09-10T10:00:00.000Z";
    const endSeconds = "2026-09-10T10:00:45.000Z";
    const endMinutes = "2026-09-10T10:05:30.000Z";
    const endHours = "2026-09-10T12:30:15.000Z";

    expect(formatDuration(start, endSeconds)).toContain("45");
    expect(formatDuration(start, endMinutes)).toContain("5");
    expect(formatDuration(start, endMinutes)).toContain("30");
    expect(formatDuration(start, endHours)).toContain("2");
    expect(formatDuration(undefined)).toBe("-");
  });
});

describe("Topological DAG Layering", () => {
  it("computes independent root nodes at Level 0", () => {
    const nodes: DagNode[] = [
      { id: "node-a", label: "Task A", state: "completed", attempt: 0, error: "" },
      { id: "node-b", label: "Task B", state: "running", attempt: 0, error: "" },
    ];
    const edges: DagEdge[] = [];

    const layers = computeDagLayers(nodes, edges);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layerIndex).toBe(0);
    expect(layers[0]?.isRoot).toBe(true);
    expect(layers[0]?.nodes.map((n) => n.id)).toEqual(["node-a", "node-b"]);
  });

  it("correctly layers chained dependencies A -> B -> C", () => {
    const nodes: DagNode[] = [
      { id: "node-a", label: "Step A", state: "completed", attempt: 0, error: "" },
      { id: "node-b", label: "Step B", state: "completed", attempt: 0, error: "" },
      { id: "node-c", label: "Step C", state: "running", attempt: 0, error: "" },
    ];
    const edges: DagEdge[] = [
      { from: "node-a", to: "node-b" },
      { from: "node-b", to: "node-c" },
    ];

    const layers = computeDagLayers(nodes, edges);
    expect(layers).toHaveLength(3);
    expect(layers[0]?.nodes.map((n) => n.id)).toEqual(["node-a"]);
    expect(layers[1]?.nodes.map((n) => n.id)).toEqual(["node-b"]);
    expect(layers[2]?.nodes.map((n) => n.id)).toEqual(["node-c"]);
  });

  it("handles diamond dependencies A -> (B, C) -> D", () => {
    const nodes: DagNode[] = [
      { id: "A", label: "Root", state: "completed", attempt: 0, error: "" },
      { id: "B", label: "Left", state: "completed", attempt: 0, error: "" },
      { id: "C", label: "Right", state: "completed", attempt: 0, error: "" },
      { id: "D", label: "Join", state: "pending", attempt: 0, error: "" },
    ];
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];

    const layers = computeDagLayers(nodes, edges);
    expect(layers).toHaveLength(3);
    expect(layers[0]?.nodes.map((n) => n.id)).toEqual(["A"]);
    expect(layers[1]?.nodes.map((n) => n.id)).toEqual(["B", "C"]);
    expect(layers[2]?.nodes.map((n) => n.id)).toEqual(["D"]);
  });

  it("builds dependency maps correctly for upstream and downstream", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
    ];

    const { upstreamMap, downstreamMap } = buildDependencyMaps(edges);
    expect(upstreamMap.get("B")).toEqual(["A"]);
    expect(upstreamMap.get("C")).toEqual(["A"]);
    expect(upstreamMap.get("D")).toEqual(["B"]);
    expect(downstreamMap.get("A")).toEqual(["B", "C"]);
    expect(downstreamMap.get("B")).toEqual(["D"]);
  });
});

describe("2D DAG Graph Geometry (computeGraphLayout)", () => {
  it("calculates 2D coordinates for nodes and direct vertical edge segments", () => {
    const nodes: DagNode[] = [
      { id: "node-1", label: "Root Task", state: "completed", attempt: 0, error: "" },
      { id: "node-2", label: "Dependent Task", state: "running", attempt: 0, error: "" },
    ];
    const edges: DagEdge[] = [{ from: "node-1", to: "node-2" }];

    const layout = computeGraphLayout(nodes, edges, {
      nodeWidth: 200,
      nodeHeight: 60,
      colGap: 30,
      rowGap: 40,
      padding: 20,
    });

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);

    const n1 = layout.nodes.find((n) => n.node.id === "node-1");
    const n2 = layout.nodes.find((n) => n.node.id === "node-2");

    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect(n1?.x).toBe(n2?.x); // Centered vertically in single-column layout
    expect(n2?.y).toBe((n1?.y ?? 0) + 60 + 40);

    const edge = layout.edges[0];
    expect(edge?.from).toBe("node-1");
    expect(edge?.to).toBe("node-2");
    expect(edge?.segments).toHaveLength(1); // Single vertical line
    expect(edge?.arrow.y).toBe((n2?.y ?? 0) - 8);
  });

  it("calculates branching (1 to 2) and joining (2 to 1) orthogonal routing segments and arrowheads", () => {
    const nodes: DagNode[] = [
      { id: "A", label: "Root", state: "completed", attempt: 0, error: "" },
      { id: "B", label: "Branch 1", state: "completed", attempt: 0, error: "" },
      { id: "C", label: "Branch 2", state: "completed", attempt: 0, error: "" },
      { id: "D", label: "Join", state: "running", attempt: 0, error: "" },
    ];
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];

    const layout = computeGraphLayout(nodes, edges, {
      nodeWidth: 100,
      nodeHeight: 50,
      colGap: 20,
      rowGap: 30,
      padding: 10,
    });

    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(4);

    // Canvas size encompasses 2 columns and 3 layers
    const expectedWidth = 2 * 100 + 20 + 2 * 10; // 240
    const expectedHeight = 3 * 50 + 2 * 30 + 2 * 10; // 230
    expect(layout.canvasWidth).toBe(expectedWidth);
    expect(layout.canvasHeight).toBe(expectedHeight);

    // Edges branching A -> B and A -> C have 3 orthogonal segments (Down, Across, Down)
    const edgeAB = layout.edges.find((e) => e.from === "A" && e.to === "B");
    const edgeAC = layout.edges.find((e) => e.from === "A" && e.to === "C");
    expect(edgeAB?.segments.length).toBeGreaterThanOrEqual(1);
    expect(edgeAC?.segments.length).toBeGreaterThanOrEqual(1);

    // Every edge has an arrowhead pointing to target node top
    for (const edge of layout.edges) {
      const targetNode = layout.nodes.find((n) => n.node.id === edge.to);
      expect(edge.arrow.y).toBe((targetNode?.y ?? 0) - 8);
    }
  });

  it("handles empty nodes gracefully", () => {
    const layout = computeGraphLayout([], []);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.canvasWidth).toBe(0);
    expect(layout.canvasHeight).toBe(0);
  });
});

describe("Task Hierarchy Computation & Multi-tier Recursion", () => {
  it("separates standalone root tasks, nests children and grandchildren, and maps DAG-linked task descendants", () => {
    const tasks: DagTask[] = [
      { id: "st_root_1", description: "Standalone Root 1", status: "completed" },
      { id: "st_root_2", description: "Standalone Root 2", status: "running" },
      { id: "st_child_1", description: "Child of Root 1", status: "completed", parentTaskId: "st_root_1" },
      { id: "st_grandchild_1", description: "Grandchild of Root 1", status: "completed", parentTaskId: "st_child_1" },
      { id: "st_dag_linked", description: "Linked to DAG Node", status: "running" },
      { id: "st_dag_subtask", description: "Child of DAG Linked", status: "running", parentTaskId: "st_dag_linked" },
    ];

    const runs: DagRun[] = [
      {
        id: "run-1",
        name: "DAG Run 1",
        status: "running",
        createdAt: "2026-09-10T10:00:00.000Z",
        updatedAt: "2026-09-10T10:05:00.000Z",
        nodes: [
          { id: "n1", label: "Node 1", state: "running", attempt: 0, taskId: "st_dag_linked", error: "" },
        ],
        edges: [],
      },
    ];

    const { standaloneRootTasks, childTasksMap, allTasksMap } = computeTaskHierarchy(tasks, runs);

    expect(allTasksMap.size).toBe(6);

    // st_dag_linked is linked to DAG node, so only st_root_1 and st_root_2 are standalone roots
    expect(standaloneRootTasks.map((t) => t.id)).toEqual(["st_root_2", "st_root_1"]);

    // Child task mapping holds direct children for recursion
    expect(childTasksMap.get("st_root_1")?.map((t) => t.id)).toEqual(["st_child_1"]);
    expect(childTasksMap.get("st_child_1")?.map((t) => t.id)).toEqual(["st_grandchild_1"]);
    expect(childTasksMap.get("st_dag_linked")?.map((t) => t.id)).toEqual(["st_dag_subtask"]);
  });
});

describe("Effective Folding State & Toggle Behavior", () => {
  it("toggles from effective current state on first click (running defaults expanded -> collapses)", () => {
    const foldedTasks: Record<string, boolean> = {};

    // Running task is expanded by default
    expect(isTaskExpanded("task-running", "running", foldedTasks)).toBe(true);

    // First click on running task collapses it (sets false)
    const afterFirstClick = toggleTaskExpanded("task-running", "running", foldedTasks);
    expect(isTaskExpanded("task-running", "running", afterFirstClick)).toBe(false);
    expect(afterFirstClick["task-running"]).toBe(false);

    // Second click expands it back
    const afterSecondClick = toggleTaskExpanded("task-running", "running", afterFirstClick);
    expect(isTaskExpanded("task-running", "running", afterSecondClick)).toBe(true);
    expect(afterSecondClick["task-running"]).toBe(true);
  });

  it("toggles from effective current state on first click (completed defaults collapsed -> expands)", () => {
    const foldedNodes: Record<string, boolean> = {};

    // Completed node is collapsed by default
    expect(isNodeExpanded("run-1", "node-completed", "completed", foldedNodes)).toBe(false);

    // First click on completed node expands it (sets true)
    const afterFirstClick = toggleNodeExpanded("run-1", "node-completed", "completed", foldedNodes);
    expect(isNodeExpanded("run-1", "node-completed", "completed", afterFirstClick)).toBe(true);
    expect(afterFirstClick["run-1:node-completed"]).toBe(true);

    // Second click collapses it back
    const afterSecondClick = toggleNodeExpanded("run-1", "node-completed", "completed", afterFirstClick);
    expect(isNodeExpanded("run-1", "node-completed", "completed", afterSecondClick)).toBe(false);
    expect(afterSecondClick["run-1:node-completed"]).toBe(false);
  });

  it("toggles run folding state correctly", () => {
    const foldedRuns: Record<string, boolean> = {};

    // Run is expanded by default
    expect(isRunExpanded("run-1", foldedRuns)).toBe(true);

    // First click folds the run
    const afterFirstClick = toggleRunExpanded("run-1", foldedRuns);
    expect(isRunExpanded("run-1", afterFirstClick)).toBe(false);

    // Second click expands the run
    const afterSecondClick = toggleRunExpanded("run-1", afterFirstClick);
    expect(isRunExpanded("run-1", afterSecondClick)).toBe(true);
  });

  it("preserves explicit user folding state across query/snapshot updates", () => {
    let foldedNodes: Record<string, boolean> = {};

    // User explicitly expands a completed node
    foldedNodes = toggleNodeExpanded("run-1", "node-1", "completed", foldedNodes);
    expect(isNodeExpanded("run-1", "node-1", "completed", foldedNodes)).toBe(true);

    // A background snapshot refetch occurs (state updated to running or completed again)
    // The user's explicit preference is retained!
    expect(isNodeExpanded("run-1", "node-1", "completed", foldedNodes)).toBe(true);
  });
});

describe("Session Stats Calculation", () => {
  it("aggregates run and task metrics accurately including failed, error, interrupted, lost", () => {
    const snapshot: DagSnapshotPayload = {
      sessionId: "session-123",
      runs: [
        {
          id: "r1",
          name: "Run 1",
          status: "running",
          createdAt: "",
          updatedAt: "",
          nodes: [],
          edges: [],
        },
        {
          id: "r2",
          name: "Run 2",
          status: "completed",
          createdAt: "",
          updatedAt: "",
          nodes: [],
          edges: [],
        },
        {
          id: "r3",
          name: "Run 3",
          status: "failed",
          createdAt: "",
          updatedAt: "",
          nodes: [],
          edges: [],
        },
      ],
      tasks: [
        { id: "st_1", status: "running" },
        { id: "st_2", status: "completed" },
        { id: "st_3", status: "failed" },
        { id: "st_4", status: "error" },
        { id: "st_5", status: "interrupted" },
        { id: "st_6", status: "lost" },
        { id: "st_7", status: "pending" },
      ],
    };

    const stats = calculateSessionStats(snapshot);
    expect(stats.totalRuns).toBe(3);
    expect(stats.runningRuns).toBe(1);
    expect(stats.completedRuns).toBe(1);
    expect(stats.failedRuns).toBe(1);

    expect(stats.totalTasks).toBe(7);
    expect(stats.runningTasks).toBe(1);
    expect(stats.completedTasks).toBe(1);
    expect(stats.failedTasks).toBe(4); // failed, error, interrupted, lost
  });

  it("handles empty or null snapshot safely", () => {
    const stats = calculateSessionStats(null);
    expect(stats.totalRuns).toBe(0);
    expect(stats.totalTasks).toBe(0);
  });
});
