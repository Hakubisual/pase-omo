import { expect, test } from "vitest";
import { activityAge } from "./task-diagnostics.js";
import { workflowActivity } from "./workflow-layout.js";
const at = "2026-10-20T00:00:00Z", now = Date.parse(at) + 20 * 60_000;
const run = { nodes: [{ id: "n", label: "Worker", state: "running" as const, attempt: 1, error: "", taskId: "st_w" }] };
test("unchanged progress keeps its recorded timestamp across later renders", () => {
  const tasks = new Map([["st_w", { id: "st_w", progress: "Old progress", progressAt: at }]]);
  expect(workflowActivity(run, tasks, now)[0]!.at).toBe(Date.parse(at));
  expect(workflowActivity(run, tasks, now + 99_000)[0]!.at).toBe(Date.parse(at));
});
test("a growing log cannot make an undated progress line look new", () => {
  const tasks = new Map([["st_w", { id: "st_w", progress: "Old progress", lastActivityAt: at, lastTool: "read" }]]);
  const events = workflowActivity(run, tasks, now);
  expect(events.find(e => e.key.endsWith(":progress"))!.at).toBeNull();
  expect(events.find(e => e.key.endsWith(":activity"))!.at).toBe(Date.parse(at));
});
test("quiet workers get a neutral silence label; missing, invalid and future activity stay unknown", () => {
  expect(activityAge({ id: "st_w", lastActivityAt: at }, now)).toBe("No recorded activity for 20m");
  for (const lastActivityAt of [undefined, "bad", "2027-01-01T00:00:00Z"]) expect(activityAge({ id: "st_w", ...(lastActivityAt ? { lastActivityAt } : {}) }, now)).toBe("Activity time not recorded");
  expect(workflowActivity(run, new Map([["st_w", { id: "st_w", progress: "Future", progressAt: "2027-01-01" }]]), now)[0]!.at).toBeNull();
});
