import { expect, it } from "vitest";
import { taskChildEvents, type TaskRecord, type TaskState } from "./task-watch.js";

const context = { parentSessionId: "parent", cwd: "/project" };
const record = (epoch: number, status = "running"): TaskRecord => ({
  task_id: "st_revived", parent_session_id: "native-parent", status, run_start_epoch: epoch,
  ...(status === "running" ? {} : { terminal_at: "2026-10-20T06:21:45.634Z" }),
});
const project = (task: TaskRecord, previous?: TaskState) => taskChildEvents({ ...context, record: task, previous });

it("reopens the same child after a terminal worker self-resumes", () => {
  const first = project(record(0, "completed"));
  const revived = project(record(1), first.state);
  expect(revived.events).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: "st_revived" }));
  expect(revived.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "started", turnId: "st_revived-run-1" }));
  expect(revived.state.closed).toBe(false);
  expect(project(record(1), revived.state).events).toEqual([]);
});

it("reports a resumed turn that starts and finishes between polls", () => {
  const first = project(record(0, "completed"));
  const next = project(record(3, "error"), first.state);
  expect(next.events).toContainEqual(expect.objectContaining({ type: "session.opened" }));
  expect(next.events).toContainEqual(expect.objectContaining({ type: "session.turn", turnId: "st_revived-run-3", state: "failed" }));
  expect(next.events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ id: "st_revived-result-3" }) }));
  expect(project(record(3, "error"), next.state).events).toEqual([]);
});

it("does not conflate later results or duplicate the same epoch", () => {
  const first = project(record(0, "completed"));
  const resumed = project(record(1), first.state);
  const final = project(record(1, "completed"), resumed.state);
  const ids = [...first.events, ...resumed.events, ...final.events].flatMap(event => event.type === "timeline.item" ? [event.item.id] : []);
  expect(ids.filter(id => id === "st_revived-summary")).toHaveLength(1);
  expect(ids).toContain("st_revived-result");
  expect(ids).toContain("st_revived-result-1");
  expect(project(record(1, "completed"), final.state).events).toEqual([]);
});

it("keeps saved replay item and turn identities stable", () => {
  expect(project(record(5, "completed"))).toEqual(project(record(5, "completed")));
});

it("replaces the host projection when the previous settlement was missed between scans", () => {
  const first = project(record(0));
  const next = project(record(1), first.state);
  expect(next.events.slice(0, 2).map(event => event.type)).toEqual(["session.closed", "session.opened"]);
  expect(next.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "started", turnId: "st_revived-run-1" }));
  expect(next.state.closed).toBe(false);
});

it("ignores older snapshots after a newer run was observed", () => {
  const current = project(record(5));
  const stale = project(record(4, "completed"), current.state);
  expect(stale.events).toEqual([]);
  expect(stale.state).toEqual(current.state);
});

it("does not reopen a same-epoch terminal record just because its terminal status changes", () => {
  const first = project(record(2, "completed"));
  expect(project(record(2, "error"), first.state).events).toEqual([]);
});

it("can observe a legacy terminal-to-running revival without an epoch field", () => {
  const legacy = { task_id: "legacy", status: "completed" };
  const first = project(legacy);
  const resumed = project({ ...legacy, status: "running" }, first.state);
  expect(resumed.events).toContainEqual(expect.objectContaining({ type: "session.opened" }));
  expect(resumed.state.closed).toBe(false);
  expect(project({ ...legacy, status: "running" }, resumed.state).events).toEqual([]);
});

it.each([-1, NaN, 1.5, Infinity])("ignores invalid run epoch %s", epoch => {
  expect(project(record(epoch)).state).not.toHaveProperty("epoch");
});
