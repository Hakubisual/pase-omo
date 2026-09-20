import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { OmoProcessOptions } from "../provider/omo-process.js";
import { OmoSession } from "../provider/omo-session.js";
import { getDagSnapshot, normalizeTask } from "./dag-store.js";

const processes = vi.hoisted(() => [] as OmoProcessOptions[]);
vi.mock("../provider/omo-process.js", () => ({
  OmoProcess: class {
    readonly whenExited = Promise.resolve();
    constructor(readonly options: OmoProcessOptions) { processes.push(options); }
    start() {}
    stop() {}
    async call(command: string) {
      return command === "get_state" ? { sessionId: "parent", cwd: this.options.cwd } : {};
    }
  },
}));
vi.mock("../provider/todo-memory.js", () => ({ lastPublishedTodo: async () => undefined }));

const roots: string[] = [];
const sessions: OmoSession[] = [];
const created = "2026-09-20T00:00:00.000Z";
const started = "2026-09-20T00:01:00.000Z";

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  processes.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "omo-live-bridge-"));
  roots.push(cwd);
  const sessionsDir = join(cwd, "sessions");
  const taskStateDir = join(cwd, "tasks-state");
  await mkdir(sessionsDir);
  await mkdir(join(taskStateDir, "tasks"), { recursive: true });
  for (const id of ["parent", "foreign"]) {
    await writeFile(join(sessionsDir, `${id}.jsonl`), JSON.stringify({ type: "session", id, cwd, timestamp: created }) + "\n");
  }
  const file = join(taskStateDir, "tasks", "st_one.json");
  await writeFile(file, JSON.stringify({
    task_id: "st_one", parent_session_id: "parent", status: "running", description: "Durable task",
    created_at: created, started_at: started, live_progress: { activity: "disk", turns: 1, tool_calls: 2 },
  }));
  const session = new OmoSession({
    paseoSessionId: `paseo-${sessions.length}`, launch: { command: "omo", base: [], origin: "test" },
    config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true }, capabilities: [],
    emit: vi.fn(), log: vi.fn(), onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  await session.open("open", "skip");
  const process = processes.at(-1);
  if (!process) throw new Error("Missing provider process");
  const options = { cwd, sessionsDir, taskStateDir };
  const snapshot = (sessionId = "parent") => getDagSnapshot({ ...options, sessionId });
  const event = (tasks: unknown[], parent = "parent", extra = {}) => process.onEvent({
    type: "extension_event", name: "omo.task.updated", data: { parent_session_id: parent, tasks, ...extra },
  });
  return { cwd, options, file, session, process, snapshot, event };
}

const live = (id = "st_one", turns = 3) => ({
  task_id: id, status: "running", run_stats: { turns: 2, tool_calls: 4 },
  live_progress: { activity: "working", started_at: started, current_tool: "grep", last_assistant_line: "Searching", turns, tool_calls: 7 },
});

test("provider extension events update DAG progress and counts without disk writes", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  f.event([live()]);
  expect((await f.snapshot()).tasks).toEqual([{
    id: "st_one", description: "Durable task", status: "running", startedAt: started,
    progress: "[grep] Searching", turns: 3, toolCalls: 7,
  }]);
  f.event([{ ...live("st_one", 8), live_progress: { activity: "thinking", turns: 8, tool_calls: 9 } }]);
  expect((await f.snapshot()).tasks[0]).toMatchObject({ progress: "thinking", turns: 8, toolCalls: 9 });
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(f.process.env.SENPI_RPC_CLIENT_CAPABILITIES?.split(",")).toEqual(expect.arrayContaining(["question", "extension_events"]));
});

test("ownership comes only from the authenticated envelope and workspace", async () => {
  const f = await fixture();
  f.event([live()], "foreign");
  f.process.onEvent({ type: "extension_event", name: "untrusted.updated", data: { parent_session_id: "parent", tasks: [live()] } });
  f.process.onEvent({ type: "extension_event", name: "omo.task.updated", data: { tasks: [live()] } });
  expect((await f.snapshot()).tasks[0]?.progress).toBe("disk");
  const other = await fixture();
  f.event([{ ...live(), parent_session_id: "foreign", prompt: "PRIVATE_PROMPT", final_response: "PRIVATE_FINAL" }]);
  expect((await f.snapshot()).tasks[0]?.progress).toBe("[grep] Searching");
  expect((await f.snapshot("foreign")).tasks).toEqual([]);
  expect((await other.snapshot()).tasks[0]?.progress).toBe("disk");
  expect(JSON.stringify(await f.snapshot())).not.toMatch(/PRIVATE_|parent_session_id|final_response/);
});

test("terminal updates clear stale live progress and prefer final run counts", async () => {
  const f = await fixture();
  f.event([live()]);
  f.event([{ ...live(), status: "completed", run_stats: { turns: 10, tool_calls: 20 } }]);
  const task = (await f.snapshot()).tasks[0];
  expect(task).toMatchObject({ status: "completed", turns: 10, toolCalls: 20 });
  expect(task).not.toHaveProperty("progress");
});

test("capped and empty event batches do not delete omitted live or durable tasks", async () => {
  const f = await fixture();
  f.event([live(), live("st_two")]);
  f.event([live("st_three")], "parent", { truncated_tasks: 50 });
  f.event([]);
  expect((await f.snapshot()).tasks.map(task => task.id).sort()).toEqual(["st_one", "st_three", "st_two"]);
});

test("suspend, resume, exit and close discard projections and reject late process events", async () => {
  const f = await fixture();
  f.event([live()]);
  expect((await f.snapshot()).tasks[0]?.turns).toBe(3);
  await f.session.suspend();
  f.event([live()]);
  expect((await f.snapshot()).tasks[0]?.progress).toBe("disk");
  await f.session.resume();
  f.event([live()]);
  expect((await f.snapshot()).tasks[0]?.progress).toBe("disk");
  const resumed = processes.at(-1);
  if (!resumed) throw new Error("Missing resumed process");
  const update = () => resumed.onEvent({ type: "extension_event", name: "omo.task.updated", data: { parent_session_id: "parent", tasks: [live()] } });
  update();
  expect((await f.snapshot()).tasks[0]?.turns).toBe(3);
  resumed.onExit({ code: 1, signal: null, stderr: "test exit" });
  update();
  expect((await f.snapshot()).tasks[0]?.progress).toBe("disk");
  const second = await fixture();
  second.event([live()]);
  second.session.close();
  second.event([live()]);
  expect((await second.snapshot()).tasks[0]?.progress).toBe("disk");
});

test("live updates cannot steal durable task ownership or regress newer terminal records", async () => {
  const f = await fixture();
  const foreignFile = join(f.options.taskStateDir, "tasks", "st_foreign.json");
  await writeFile(foreignFile, JSON.stringify({ task_id: "st_foreign", parent_session_id: "foreign", status: "running" }));
  f.event([live("st_foreign")]);
  expect((await f.snapshot()).tasks.map(task => task.id)).toEqual(["st_one"]);
  expect((await f.snapshot("foreign")).tasks[0]).not.toHaveProperty("progress");
  f.event([live()]);
  expect((await f.snapshot()).tasks[0]?.status).toBe("running");
  await writeFile(f.file, JSON.stringify({
    task_id: "st_one", parent_session_id: "parent", status: "completed", updated_at: started,
    run_stats: { turns: 12, tool_calls: 30 },
  }));
  expect((await f.snapshot()).tasks[0]).toMatchObject({ status: "completed", turns: 12, toolCalls: 30 });
  expect((await f.snapshot()).tasks[0]).not.toHaveProperty("progress");
  f.event([{ ...live(), updated_at: created }]);
  expect((await f.snapshot()).tasks[0]).toMatchObject({ status: "completed", turns: 12, toolCalls: 30 });
  expect((await f.snapshot()).tasks[0]).not.toHaveProperty("progress");
});

test("terminal events without run_stats preserve durable final counters", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({
    task_id: "st_one", parent_session_id: "parent", status: "completed", run_stats: { turns: 12, tool_calls: 30 },
  }));
  f.event([{ task_id: "st_one", status: "completed" }]);
  expect((await f.snapshot()).tasks[0]).toMatchObject({ status: "completed", turns: 12, toolCalls: 30 });
});

test("persisted started_at precedes created_at when live timestamps are absent", () => {
  expect(normalizeTask({ task_id: "st_one", created_at: created, started_at: started })?.startedAt).toBe(started);
});
