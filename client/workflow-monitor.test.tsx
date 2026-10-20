import { expect, test, vi } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import type { DagRun } from "../shared/dag.js";
import { focusedNodes, outcomeSummary, WorkflowMonitor } from "./workflow-monitor.js";
const node = (id: string, state: DagRun["status"]) => ({ id, label: id, state, attempt: 1, error: "" });
const run: DagRun = { id: "r", name: "Run", status: "running", createdAt: "", updatedAt: "", nodes: [node("a", "completed"), node("b", "running"), node("c", "pending"), node("d", "failed"), node("e", "cancelled"), node("f", "skipped"), node("g", "blocked"), node("h", "scheduled"), node("i", "paused")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
const theme = { colors: {} } as PluginTheme;
function elements(value: any): any[] { return Array.isArray(value) ? value.flatMap(elements) : value?.props ? [value, ...elements(value.props.children)] : []; }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join(" ") : value?.props ? text(value.props.children) : typeof value === "string" ? value : ""; }
test("outcomes account for every state without reporting settled nodes as success", () => {
  expect(outcomeSummary(run)).toBe("1 done · 1 running · 3 waiting · 1 paused · 1 failed · 1 cancelled · 1 skipped");
  expect(outcomeSummary({ ...run, nodes: [] })).toBe("No nodes");
});
test("focus uses real running states, not elapsed time or worker activity", () => {
  expect([...focusedNodes(run, "running", "d")]).toEqual(["b"]);
  expect([...focusedNodes({ ...run, nodes: run.nodes.filter(n => n.state !== "running") }, "running", null)]).toEqual([]);
});
test("selected focus follows transitive prerequisites, handles cycles and excludes descendants", () => {
  expect([...focusedNodes(run, "dependencies", "b")].sort()).toEqual(["a", "b"]);
  expect([...focusedNodes(run, "dependencies", "c")].sort()).toEqual(["a", "b", "c"]);
  expect([...focusedNodes({ ...run, edges: [...run.edges, { from: "c", to: "a" }] }, "dependencies", "a")].sort()).toEqual(["a", "b", "c"]);
});
test("missing selections restore all nodes and focus never mutates graph order", () => {
  const before = JSON.stringify(run);
  for (const selected of [null, "deleted"]) expect([...focusedNodes(run, "dependencies", selected)]).toEqual(run.nodes.map(n => n.id));
  focusedNodes(run, "running", null); focusedNodes(run, "dependencies", "c");
  expect(JSON.stringify(run)).toBe(before);
});
test("controls are labelled selectable buttons with no execution actions", () => {
  const onChange = vi.fn();
  const buttons = elements(WorkflowMonitor({ run, selected: "c", mode: "all", onChange, theme })).filter(e => e.props.accessibilityRole === "button");
  expect(buttons.map(e => e.props.accessibilityLabel)).toEqual(["Show all", "Focus running", "Selected + dependencies"]);
  buttons[1].props.onPress(); expect(onChange).toHaveBeenLastCalledWith("running");
  buttons[2].props.onPress(); expect(onChange).toHaveBeenLastCalledWith("dependencies");
  expect(buttons[0].props.accessibilityState.selected).toBe(true);
  const missing = elements(WorkflowMonitor({ run, selected: null, mode: "dependencies", onChange, theme }));
  expect(missing.find(e => e.props.accessibilityLabel === "Selected + dependencies").props.disabled).toBe(true);
  expect(missing.find(e => e.props.accessibilityLabel === "Show all").props.accessibilityState.selected).toBe(true);
});
test("running focus has an honest empty state", () => {
  expect(text(WorkflowMonitor({ run: { ...run, nodes: [] }, selected: null, mode: "running", onChange: vi.fn(), theme }))).toContain("No nodes are currently running");
});
