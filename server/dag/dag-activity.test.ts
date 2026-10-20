import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { getDagSnapshot, normalizeTask } from "./dag-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dag-activity-")); roots.push(root);
  const cwd = join(root, "project"), store = join(root, "state"), sessions = join(root, "sessions");
  for (const p of [cwd, sessions, join(store, "tasks"), join(store, "logs")]) await mkdir(p, { recursive: true });
  await writeFile(join(sessions, "parent.jsonl"), JSON.stringify({ type: "session", id: "parent", cwd, timestamp: "2026-10-19T00:00:00Z" }) + "\n");
  const task = { task_id: "st_live", parent_session_id: "parent", status: "running", created_at: "2026-10-19T00:00:00Z", started_at: "2026-10-19T00:00:03Z", spawn_spec: { cwd } };
  const taskFile = join(store, "tasks/st_live.json"), log = join(store, "logs/st_live.jsonl");
  await writeFile(taskFile, JSON.stringify(task));
  const snapshot = async () => (await getDagSnapshot({ cwd, taskStateDir: store, sessionsDir: sessions, sessionId: "parent" })).tasks[0]!;
  return { root, task, taskFile, log, snapshot };
}
const tool = (name: string) => JSON.stringify({ type: "tool_execution", payload: { tool: name, is_error: false } }) + "\n";

test("native cancellation reasons survive projection without exposing spawn prompts", () => {
  const t = normalizeTask({ task_id: "st_reason", status: "cancelled", error_message: "Superseded by replacement run", spawn_spec: { prompt: "PRIVATE" } });
  expect(t).toMatchObject({ terminalReason: "Superseded by replacement run" });
  expect(JSON.stringify(t)).not.toContain("PRIVATE");
  expect(normalizeTask({ task_id: "st_active", status: "running", error_message: "stale" })).not.toHaveProperty("terminalReason");
});

test("a running native worker gets observed tool activity without live_progress", async () => {
  const f = await fixture(); await writeFile(f.log, tool("read") + tool("eval"));
  const t = await f.snapshot();
  expect(t).toMatchObject({ observedToolCalls: 2, lastTool: "eval", progress: "Last tool: eval", startedAt: "2026-10-19T00:00:03.000Z" });
  expect(t.lastActivityAt).toBeDefined();
  expect(t.toolCalls).toBeUndefined(); // Observed events are not authoritative native totals.
});

test("activity updates incrementally without counting unchanged or partial entries twice", async () => {
  const f = await fixture(); await writeFile(f.log, tool("read") + '{"type":"tool_execution","payload":{"tool":"');
  expect((await f.snapshot()).observedToolCalls).toBe(1);
  expect((await f.snapshot()).observedToolCalls).toBe(1);
  await appendFile(f.log, 'edit"}}\n');
  expect(await f.snapshot()).toMatchObject({ observedToolCalls: 2, lastTool: "edit" });
});

test("native totals win and terminal tasks keep the reason without a stale activity line", async () => {
  const f = await fixture(); await writeFile(f.log, tool("read")); await f.snapshot();
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, status: "failed", error_message: "Provider unavailable", terminal_at: "2026-10-19T00:01:00Z", run_stats: { tool_calls: 9, turns: 3 } }));
  const t = await f.snapshot();
  expect(t).toMatchObject({ terminalReason: "Provider unavailable", toolCalls: 9, turns: 3 });
  expect(t.progress).toBeUndefined(); expect(t.observedToolCalls).toBeUndefined();
});

test("log replacement and truncation reset observed counts", async () => {
  const f = await fixture(); await writeFile(f.log, tool("read") + tool("eval"));
  expect((await f.snapshot()).observedToolCalls).toBe(2);
  await writeFile(f.log, tool("edit"));
  expect(await f.snapshot()).toMatchObject({ observedToolCalls: 1, lastTool: "edit" });
  await rm(f.log); await writeFile(f.log, tool("webfetch"));
  expect(await f.snapshot()).toMatchObject({ observedToolCalls: 1, lastTool: "webfetch" });
});

test("oversized or malformed activity is bounded, visible as partial, and never leaks payload text", async () => {
  const f = await fixture();
  await writeFile(f.log, JSON.stringify({ type: "assistant_message", payload: { text: "PRIVATE".repeat(50000) } }) + "\nnot json\n" + tool("read"));
  const t = await f.snapshot();
  expect(t).toMatchObject({ observedToolCalls: 1, lastTool: "read" });
  expect(t.activityError).toMatch(/partial/);
  expect(JSON.stringify(t)).not.toContain("PRIVATE");
});

test("concurrent snapshots share an incremental read and preserve native progress", async () => {
  const f = await fixture(); await writeFile(f.log, tool("read"));
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, live_progress: { current_tool: "eval", tool_calls: 12, turns: 4 } }));
  const results = await Promise.all([f.snapshot(), f.snapshot(), f.snapshot()]);
  for (const t of results) expect(t).toMatchObject({ observedToolCalls: 1, toolCalls: 12, turns: 4, progress: "[eval]" });
});

test("large valid logs catch up across read budgets without duplicate counts", async () => {
  const f = await fixture();
  await writeFile(f.log, tool("x".repeat(128)).repeat(9000) + tool("final"));
  const first = await f.snapshot();
  expect(first.observedToolCalls).toBeGreaterThan(0);
  expect(first.observedToolCalls).toBeLessThan(9001);
  expect(first.activityError).toMatch(/partial/);
  const complete = await f.snapshot();
  expect(complete).toMatchObject({ observedToolCalls: 9001, lastTool: "final" });
  expect(complete.activityError).toBeUndefined();
  expect((await f.snapshot()).observedToolCalls).toBe(9001);
});

test("progress timestamps come only from their native progress record, never task status writes", () => {
  const base = { task_id: "st_time", status: "running", updated_at: "2026-10-20T12:00:00Z", live_progress: { activity: "Still waiting" } };
  expect(normalizeTask(base)?.progressAt).toBeUndefined();
  expect(normalizeTask({ ...base, live_progress: { ...base.live_progress, updated_at: "2026-10-20T11:00:00Z" } })?.progressAt).toBe("2026-10-20T11:00:00.000Z");
  expect(normalizeTask({ ...base, status: "completed" })?.progressAt).toBeUndefined();
});
