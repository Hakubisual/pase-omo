import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  isTerminalTask,
  readTaskRecords,
  taskChildEvents,
  taskSummaryLine,
  type TaskRecord,
  type TaskState,
} from "./task-watch.js";

/**
 * A `task()` run left nothing on screen but a flat tool-call row. These pin the
 * two halves of the fix: which records belong to this session, and what a
 * record says the first time it is seen versus every pass after it.
 */

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "st_abc123",
    status: "running",
    parent_session_id: "omo-session-1",
    task_summary: "Check the release notes",
    description: "Release notes check",
    category: "quick",
    model: "commandcode/z-ai/glm-5.3-flash",
    ...overrides,
  };
}

const context = { parentSessionId: "paseo-session-1", cwd: "/project" };

it("opens a child session the first time a task is seen", () => {
  const { events, state } = taskChildEvents({ ...context, record: record(), previous: undefined });

  expect(events.map((event) => event.type)).toEqual(["session.opened", "timeline.item", "session.turn"]);
  const opened = events[0] as Extract<(typeof events)[number], { type: "session.opened" }>;
  expect(opened).toMatchObject({
    sessionId: "st_abc123",
    parentSessionId: "paseo-session-1",
    cwd: "/project",
    title: "Release notes check",
  });
  expect(opened.description).toBe("Check the release notes (quick · commandcode/z-ai/glm-5.3-flash)");
  expect(state).toEqual({ status: "running", opened: true, closed: false });
});

it("says nothing on a pass where the task did not move", () => {
  const previous: TaskState = { status: "running", opened: true, closed: false };
  const { events, state } = taskChildEvents({ ...context, record: record(), previous });

  expect(events).toEqual([]);
  expect(state).toEqual(previous);
});

it("closes the child when the task reaches a terminal status", () => {
  const previous: TaskState = { status: "running", opened: true, closed: false };
  const { events, state } = taskChildEvents({
    ...context,
    record: record({ status: "completed", terminal_at: "2026-09-18T13:52:08.949Z" }),
    previous,
  });

  expect(events.map((event) => event.type)).toEqual(["timeline.item", "session.turn", "session.closed"]);
  expect(events[1]).toMatchObject({ state: "completed" });
  expect(state.closed).toBe(true);
});

it("reports a failed task as a failed turn", () => {
  const previous: TaskState = { status: "running", opened: true, closed: false };
  const { events } = taskChildEvents({
    ...context,
    record: record({ status: "error", terminal_at: "2026-09-18T13:52:08.949Z" }),
    previous,
  });

  expect(events[1]).toMatchObject({ type: "session.turn", state: "failed" });
});

it("still opens a task that was already finished when it was first seen", () => {
  const { events, state } = taskChildEvents({
    ...context,
    record: record({ status: "completed", terminal_at: "2026-09-18T13:52:08.949Z" }),
    previous: undefined,
  });

  // The row is how the run is reachable at all, so a run that finished while
  // nobody was watching still opens before it closes.
  expect(events.map((event) => event.type)).toEqual([
    "session.opened",
    "timeline.item",
    "session.turn",
    "timeline.item",
    "session.turn",
    "session.closed",
  ]);
  expect(state).toEqual({ status: "completed", opened: true, closed: true });
});

it("says nothing more once the child is closed", () => {
  const previous: TaskState = { status: "completed", opened: true, closed: true };
  const { events } = taskChildEvents({
    ...context,
    record: record({ status: "completed" }),
    previous,
  });

  expect(events).toEqual([]);
});

it("reopens the same task for a new persisted run epoch and deduplicates each observation", () => {
  const completed0 = { ...record({ status: "completed", terminal_at: "2026-09-20T08:00:00Z" }), notification: { run_epoch: 0 } };
  const first = taskChildEvents({ ...context, record: completed0, previous: undefined });
  expect(first.events.filter(event => event.type === "session.turn")).toEqual([
    expect.objectContaining({ turnId: "st_abc123-run", state: "started" }),
    expect.objectContaining({ turnId: "st_abc123-run", state: "completed" }),
  ]);
  expect(taskChildEvents({ ...context, record: completed0, previous: first.state }).events).toEqual([]);

  const running1 = { ...record(), notification: { run_epoch: 1 } };
  const revived = taskChildEvents({ ...context, record: running1, previous: first.state });
  expect(revived.events.map(event => event.type)).toEqual(["session.opened", "timeline.item", "session.turn"]);
  expect(revived.events[0]).toMatchObject({ sessionId: "st_abc123", parentSessionId: context.parentSessionId });
  expect(revived.events[2]).toMatchObject({ turnId: "st_abc123-run-1", state: "started" });
  expect(revived.state).toMatchObject({ runEpoch: 1, status: "running", closed: false });
  expect(taskChildEvents({ ...context, record: running1, previous: revived.state })).toEqual({ events: [], state: revived.state });
  expect(taskChildEvents({ ...context, record: completed0, previous: revived.state })).toEqual({ events: [], state: revived.state });

  const completed1 = { ...running1, status: "completed", terminal_at: "2026-09-20T09:00:00Z" };
  const finished = taskChildEvents({ ...context, record: completed1, previous: revived.state });
  expect(finished.events.map(event => event.type)).toEqual(["timeline.item", "session.turn", "session.closed"]);
  expect(finished.events[1]).toMatchObject({ turnId: "st_abc123-run-1", state: "completed" });
  expect(finished.state).toMatchObject({ runEpoch: 1, closed: true });
  expect(taskChildEvents({ ...context, record: completed1, previous: finished.state }).events).toEqual([]);
  const itemIds = [...first.events, ...revived.events, ...finished.events]
    .filter(event => event.type === "timeline.item").map(event => event.item.id);
  expect(new Set(itemIds).size).toBe(itemIds.length);
});

it("observes a new epoch even when both observations are already completed", () => {
  const initial = taskChildEvents({ ...context, record: record({ status: "completed" }), previous: undefined });
  const next = taskChildEvents({
    ...context,
    record: { ...record({ status: "completed" }), notification: { run_epoch: 1 } },
    previous: initial.state,
  });
  expect(next.events.filter(event => event.type === "session.turn")).toEqual([
    expect.objectContaining({ turnId: "st_abc123-run-1", state: "started" }),
    expect.objectContaining({ turnId: "st_abc123-run-1", state: "completed" }),
  ]);
});

it.each([
  ["cancelled", "canceled"],
  ["interrupted", "canceled"],
  ["lost", "failed"],
  ["error", "failed"],
] as const)("maps native %s to a %s child turn", (status, expected) => {
  expect(isTerminalTask(record({ status }))).toBe(true);
  const started = taskChildEvents({ ...context, record: record(), previous: undefined });
  const result = taskChildEvents({
    ...context,
    record: record({ status, terminal_at: "2026-09-20T08:00:00Z" }),
    previous: started.state,
  });
  expect(result.events.map(event => event.type)).toEqual(["timeline.item", "session.turn", "session.closed"]);
  expect(result.events[1]).toMatchObject({ type: "session.turn", state: expected });
  if (expected === "failed") expect(result.events[1]).toHaveProperty("error.message");
  else expect(result.events[1]).not.toHaveProperty("error");
});

it("treats a record with no terminal marker and a running status as live", () => {
  expect(isTerminalTask(record())).toBe(false);
  expect(isTerminalTask(record({ status: "cancelled" }))).toBe(true);
  expect(isTerminalTask(record({ status: "running", terminal_at: "2026-09-18T13:52:08.949Z" }))).toBe(true);
});

it("names a task with no summary by its id", () => {
  expect(
    taskSummaryLine({ task_id: "st_bare" } as TaskRecord),
  ).toBe("st_bare");
});

it("reads only the records this session spawned", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-watch-"));
  roots.push(root);
  const dir = join(root, ".omo", "senpi-task", "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "st_mine.json"), JSON.stringify(record({ task_id: "st_mine" })));
  await writeFile(
    join(dir, "st_other.json"),
    JSON.stringify(record({ task_id: "st_other", parent_session_id: "another-session" })),
  );
  await writeFile(join(dir, "st_broken.json"), "{ not json");
  await writeFile(join(dir, "notes.txt"), "ignored");

  const records = await readTaskRecords(root, "omo-session-1");

  expect(records.map((entry) => entry.task_id)).toEqual(["st_mine"]);
});

it("treats a project with no task directory as having no children", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-watch-"));
  roots.push(root);

  expect(await readTaskRecords(root, "omo-session-1")).toEqual([]);
});

it("reads the same overridden task store as the DAG snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-override-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", stateRoot);
  await mkdir(join(stateRoot, "tasks"), { recursive: true });
  await writeFile(join(stateRoot, "tasks", "st_override.json"), JSON.stringify(record({ task_id: "st_override" })));
  expect((await readTaskRecords(join(root, "project"), "omo-session-1")).map((task) => task.task_id))
    .toEqual(["st_override"]);
});
