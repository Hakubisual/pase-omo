import { expect, test } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import type { DagRun, DagTask } from "../shared/dag.js";
import { NodeInspectorContent } from "./node-inspector.js";
const run: DagRun = { id: "r", name: "Run", status: "completed", createdAt: "", updatedAt: "", nodes: [{ id: "a", label: "A", state: "completed", attempt: 1, error: "", outputBytes: 0 }], edges: [] };
const theme = { colors: {} } as PluginTheme;
function text(value: any): string { return Array.isArray(value) ? value.map(text).join(" ") : value?.props ? text(value.props.children) : typeof value === "string" ? value : ""; }
function render(task?: DagTask, node = run.nodes[0]!) { return text(NodeInspectorContent({ run, node, task, tasks: [], scope: undefined, theme, onSelectNode: () => {}, now: 100000 })); }
test("inspector exposes clear sections and unknown values without inferring settings", () => {
  const content = render();
  for (const heading of ["Execution", "Routing", "Activity", "Dependencies", "Result", "Recorded history", "Workers"]) expect(content).toContain(heading);
  expect(content).toContain("Reasoning (recorded): Not recorded"); expect(content).toContain("No worker assigned");
  expect(content).toContain("Native record contains no output"); expect(content).toContain("1 recorded; these can include reattachments, not just retries");
});
test("effective model is explicit and the requested route appears only when different", () => {
  const content = render({ id: "st_x", model: "Friendly", modelRef: "p/current", modelStage: "effective", requestedModel: "p/planned", reasoning: "high", variant: "max" });
  expect(content).toContain("Effective model: p/current"); expect(content).toContain("Requested model: p/planned");
  expect(content).toContain("Reasoning (recorded): high"); expect(content).toContain("Variant (recorded): max");
  expect(render({ id: "st_x", modelRef: "p/current", requestedModel: "p/current" })).not.toContain("Requested model:");
});
test("native attempt counts and separate worker state stay truthful after early node completion", () => {
  const content = render({ id: "st_x", status: "running", startedAt: "1970-01-01T00:00:00Z" });
  expect(content).toContain("Done · attempt 1"); expect(content).toContain("Worker status: running");
  expect(content).toContain("Elapsed: Not recorded");
  expect(render(undefined, { ...run.nodes[0]!, attempt: 0 })).toContain("not dispatched");
});
test("terminal elapsed uses its recorded clock and result previews label truncation", () => {
  const content = render(undefined, { ...run.nodes[0]!, startedAt: "1970-01-01T00:00:00Z", completedAt: "1970-01-01T00:00:30Z", outputPreview: "Result", outputBytes: 4000, outputTruncated: true });
  expect(content).toContain("Elapsed: 30s"); expect(content).toContain("4000 bytes recorded"); expect(content).toContain("Use worker output for more");
});

test("planned and resolved model provenance is never advertised as an effective observation", () => {
  const planned = render({ id: "st_x", modelRef: "p/planned", modelStage: "planned" });
  expect(planned).toContain("Planned model: p/planned"); expect(planned).not.toContain("Effective model:");
  const resolved = render({ id: "st_x", modelRef: "p/resolved", modelStage: "resolved" });
  expect(resolved).toContain("Resolved at spawn: p/resolved"); expect(resolved).not.toContain("Effective model:");
  const attempts = render(undefined, { ...run.nodes[0]!, attempt: 5, execAttempt: 2 });
  expect(attempts).toContain("5 recorded; these can include reattachments"); expect(attempts).toContain("Execution attempt: 2");
  expect(attempts).not.toContain("4 retries");
});
