import { expect, test } from "vitest";
import { normalizeRun, normalizeTask } from "./dag-store.js";
import { DagRunSchema, DagTaskSchema } from "../../shared/dag.js";
const model = (id: string, extra = {}) => ({ provider: "provider", model_id: id, ...extra });
const raw = { runId: "run", status: "completed", nodes: [{ id: "a", state: "completed", attempt: 2, route: { kind: "agent", agent: "reviewer", model: "provider/planned" }, output: "Finished", outputBytes: 8, startedAt: "2026-10-20T01:00:00Z", completedAt: "2026-10-20T01:01:00Z", prompt: "PRIVATE_PROMPT", resultArtifact: "/private/file" }], edges: [] };
test("checkpoint details retain results and native attempt counts, excluding prompts/artifacts", () => {
  const run = normalizeRun(raw)!;
  expect(run.nodes[0]).toMatchObject({ attempt: 2, route: "reviewer", routeKind: "agent", requestedModel: "provider/planned", outputPreview: "Finished", outputBytes: 8, outputTruncated: false, startedAt: "2026-10-20T01:00:00.000Z" });
  expect(DagRunSchema.safeParse(run).success).toBe(true);
  expect(JSON.stringify(run)).not.toMatch(/PRIVATE|private\/file/);
});
test("result limits use persisted byte counts and distinguish empty from missing", () => {
  const node = raw.nodes[0]!;
  const project = (extra: object) => normalizeRun({ ...raw, nodes: [{ ...node, ...extra }] })!.nodes[0]!;
  expect(project({ output: "🧪".repeat(3000), outputBytes: 12000 })).toMatchObject({ outputTruncated: true });
  expect(project({ output: "abc", outputBytes: 3000 })).toMatchObject({ outputTruncated: true });
  expect(project({ output: "", outputBytes: 0 }).outputPreview).toBe("");
  expect(project({ output: undefined, outputBytes: undefined })).not.toHaveProperty("outputPreview");
});
test("only node-owned diagnostics are projected with bounded counts and text", () => {
  const diagnostics = Array.from({ length: 30 }, (_, i) => ({ kind: "route_fallback", nodeId: "a", message: `entry${i} ` + "x".repeat(2000), at: "2026-10-20T01:00:00Z", prompt: "PRIVATE" }));
  const run = normalizeRun({ ...raw, diagnostics: [...diagnostics, { nodeId: "foreign", message: "PRIVATE" }, { kind: "run_flag", message: "PRIVATE" }] })!;
  expect(run.nodes[0]?.diagnosticCount).toBe(30); expect(run.nodes[0]?.diagnostics).toHaveLength(20);
  expect(run.nodes[0]?.diagnostics?.[0]?.message).toHaveLength(1000);
  expect(JSON.stringify(run)).not.toContain("PRIVATE"); expect(DagRunSchema.safeParse(run).success).toBe(true);
});
test("reasoning follows the effective model without copying a stale resolution", () => {
  const base = { task_id: "st_route", requested_model: model("planned"), resolved_model: model("planned", { reasoning_effort: "high", variant: "max" }) };
  const changed = normalizeTask({ ...base, effective_model: model("fallback") })!;
  expect(changed.modelRef).toBe("provider/fallback"); expect(changed.requestedModel).toBe("provider/planned");
  expect(changed.reasoning).toBeUndefined(); expect(changed.variant).toBeUndefined();
  const live = normalizeTask({ ...base, effective_model: model("planned", { change: { kind: "set" } }) })!;
  expect(live.reasoning).toBeUndefined();
  expect(normalizeTask({ ...base, effective_model: model("planned") })?.reasoning).toBe("high");
  expect(normalizeTask({ ...base, effective_model: model("fallback", { reasoning_effort: "low" }) })?.reasoning).toBe("low");
});
test("requested models are deduplicated and model attempts remain separate from DAG retries", () => {
  const task = normalizeTask({ task_id: "st_route", effective_model: model("same"), requested_model: model("same"), fallback_attempts: Array.from({ length: 30 }, (_, i) => model(`m${i}`, { reasoning: "low", prompt: "PRIVATE" })) })!;
  expect(task.requestedModel).toBeUndefined(); expect(task.modelAttemptCount).toBe(30); expect(task.modelAttempts).toHaveLength(20);
  expect(task.modelAttempts?.[0]?.model).toBe("provider/m10"); expect(JSON.stringify(task)).not.toContain("PRIVATE");
  expect(DagTaskSchema.safeParse(task).success).toBe(true);
});

test("canonical native reasoning wins over deprecated aliases and planned routes are not called effective", () => {
  const t = normalizeTask({ task_id: "st_new", effective_model: model("new", { reasoning: "max", reasoning_effort: "low" }) })!;
  expect(t).toMatchObject({ modelStage: "effective", reasoning: "max" });
  expect(normalizeTask({ task_id: "st_plan", model: "p/planned" })?.modelStage).toBe("planned");
  expect(normalizeTask({ task_id: "st_resolved", resolved_model: model("planned", { reasoning: "high" }) })).toMatchObject({ modelStage: "resolved", reasoning: "high" });
});
test("dispatch attempt and execution attempt stay distinct", () => {
  const n = normalizeRun({ ...raw, nodes: [{ ...raw.nodes[0], attempt: 5, execAttempt: 2 }] })!.nodes[0]!;
  expect(n).toMatchObject({ attempt: 5, execAttempt: 2 });
});

test("effective legacy reasoning wins over canonical spawn reasoning and live switches do not inherit", () => {
  const base = { task_id: "st_precedence", resolved_model: model("same", { reasoning: "high" }) };
  expect(normalizeTask({ ...base, effective_model: model("same", { reasoning_effort: "low" }) })?.reasoning).toBe("low");
  expect(normalizeTask({ ...base, effective_model: model("same", { source: "set" }) })?.reasoning).toBeUndefined();
  expect(normalizeTask({ task_id: "st_old", resolved_model: model("old", { variant: "medium" }) })?.reasoning).toBe("medium");
});
