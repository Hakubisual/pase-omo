import type { PluginTheme } from "@getpaseo/plugin";
import { expect, test, vi } from "vitest";
import { dependencyExplanation, NodeDependencies } from "./node-dependencies.js";
import type { DagRun } from "../shared/dag.js";
const node = (id: string, state: DagRun["nodes"][number]["state"]) => ({ id, label: id, state, attempt: 1, error: "" });
const run: DagRun = { id: "run", name: "run", status: "running", createdAt: "", updatedAt: "", nodes: [node("a", "completed"), node("b", "running"), node("c", "pending")], edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }] };
test("waiting names only unsatisfied direct dependencies with their native states", () => {
  expect(dependencyExplanation(run, run.nodes[2]!)).toBe("Waiting for: b (Running).");
  expect(dependencyExplanation(run, run.nodes[1]!)).toBeUndefined();
});
test("a ready dependent is not held by an unrelated sibling in the same wave", () => {
  const next = { ...run, edges: [{ from: "a", to: "c" }] };
  expect(dependencyExplanation(next, next.nodes[2]!)).toContain("Dependencies are satisfied");
});
test("queued work never invents capacity reasons and paused runs explain the pause", () => {
  const queued = node("q", "scheduled");
  expect(dependencyExplanation(run, queued)).toContain("no more specific queue reason");
  expect(dependencyExplanation({ ...run, status: "paused" }, queued)).toBe("This run is paused.");
  const failed = { ...run, nodes: [node("b", "failed"), run.nodes[2]!] };
  expect(dependencyExplanation(failed, run.nodes[2]!)).toContain("incomplete");
});
test("dependency actions select their recorded node rather than guessing another task", () => {
  const onSelectNode = vi.fn();
  const tree = NodeDependencies({ run, node: run.nodes[2]!, theme: { colors: {} } as PluginTheme, onSelectNode });
  const actions = tree.props.children[2];
  actions[1]!.props.onPress(); expect(onSelectNode).toHaveBeenCalledWith("b");
});
