import { afterEach, expect, test, vi } from "vitest";
import { LiveTaskStore } from "./live-tasks.js";

const cwd = process.cwd();
const task = (id: string) => ({ task_id: id, status: "running", live_progress: { activity: "active", turns: 1 } });
const envelope = (tasks: unknown[]) => ({ parent_session_id: "parent", tasks });
afterEach(() => vi.restoreAllMocks());

test("retains only bounded allowlisted fields, stripping terminal live progress", () => {
  const store = new LiveTaskStore();
  const owner = Symbol();
  store.update(owner, cwd, "parent", envelope([{
    ...task("st_one"), status: "completed", description: "x".repeat(4000), parent_session_id: "foreign",
    prompt: "PRIVATE", final_response: "PRIVATE", spawn_spec: { prompt: "PRIVATE" },
    run_stats: { turns: 3, tool_calls: 4, secret: "PRIVATE" },
  }]));
  expect(store.records(cwd)).toEqual([{
    parentSessionId: "parent", receivedAt: expect.any(Number),
    raw: { task_id: "st_one", status: "completed", description: "x".repeat(2000), run_stats: { turns: 3, tool_calls: 4 } },
  }]);
});

test("malformed and foreign envelopes cannot erase valid state", () => {
  const store = new LiveTaskStore();
  const owner = Symbol();
  store.update(owner, cwd, "parent", envelope([task("st_one")]));
  for (const data of [null, [], { tasks: [] }, { parent_session_id: "foreign", tasks: [task("st_two")] }, envelope([null, {}, { task_id: "../bad", status: "running" }, { task_id: "st_bad" }])]) {
    store.update(owner, cwd, "parent", data);
  }
  expect(store.records(cwd).map(entry => entry.raw.task_id)).toEqual(["st_one"]);
});

test("task and session caps bound retained memory without replacing whole batches", () => {
  const store = new LiveTaskStore();
  const owner = Symbol();
  store.update(owner, cwd, "parent", envelope(Array.from({ length: 300 }, (_, n) => task(`st_${n}`))));
  expect(store.records(cwd)).toHaveLength(256);
  for (let batch = 1; batch < 5; batch++) {
    store.update(owner, cwd, "parent", envelope(Array.from({ length: 256 }, (_, n) => task(`st_${batch * 256 + n}`))));
  }
  expect(store.records(cwd)).toHaveLength(1024);
  expect(store.records(cwd)[0]?.raw.task_id).toBe("st_256");
  for (let n = 0; n < 128; n++) store.update(Symbol(), cwd, "parent", envelope([task(`st_owner_${n}`)]));
  expect(store.records(cwd)).toHaveLength(128);
});

test("individual entries expire without activity from other tasks refreshing them", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const store = new LiveTaskStore();
  const owner = Symbol();
  store.update(owner, cwd, "parent", envelope([task("st_old")]));
  clock.mockReturnValue(29 * 60 * 1000);
  store.update(owner, cwd, "parent", envelope([task("st_new")]));
  clock.mockReturnValue(30 * 60 * 1000);
  expect(store.records(cwd).map(entry => entry.raw.task_id)).toEqual(["st_new"]);
  store.clear(owner);
  expect(store.records(cwd)).toEqual([]);
});

test("changing durable owner replaces only that provider instance's projections", () => {
  const store = new LiveTaskStore();
  const owner = Symbol();
  const other = Symbol();
  store.update(owner, cwd, "parent", envelope([task("st_one")]));
  store.update(other, cwd, "parent", envelope([task("st_other")]));
  store.update(owner, cwd, "next", { parent_session_id: "next", tasks: [task("st_next")] });
  expect(store.records(cwd).map(entry => [entry.parentSessionId, entry.raw.task_id])).toEqual([
    ["parent", "st_other"], ["next", "st_next"],
  ]);
  store.clear(owner);
  expect(store.records(cwd).map(entry => entry.raw.task_id)).toEqual(["st_other"]);
});
