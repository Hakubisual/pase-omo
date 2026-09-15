import { expect, test } from "vitest";

import { TODO_ROW_KIND, TODO_ROW_VERSION, TodoRowSchema, todoPluginItems, toTodoRow } from "./todo";

/**
 * The card is built from the agent's own todo timeline item, so every shape the
 * protocol allows has to land somewhere readable: `status` is optional, and the
 * older `completed` boolean is the only signal when it is missing.
 */

test("an explicit status wins, because it carries the in-progress step", () => {
  const row = toTodoRow(
    [
      { text: "read the spec", completed: true, status: "completed", id: "a" },
      { text: "write the test", completed: false, status: "in_progress", id: "b", activeForm: "writing the test" },
      { text: "ship it", completed: false, status: "pending", id: "c" },
    ],
    "streaming",
  );

  expect(row).not.toBeNull();
  expect(row?.entries).toEqual([
    { id: "a", text: "read the spec", status: "completed" },
    { id: "b", text: "write the test", status: "in_progress", activeForm: "writing the test" },
    { id: "c", text: "ship it", status: "pending" },
  ]);
  expect(row?.phase).toBe("streaming");
});

test("the completed flag stands in when the item carries no status", () => {
  const row = toTodoRow(
    [
      { text: "done thing", completed: true },
      { text: "todo thing", completed: false },
    ],
    "complete",
  );

  expect(row?.entries.map((entry) => entry.status)).toEqual(["completed", "pending"]);
});

test("entries without ids still get stable keys from their position", () => {
  const row = toTodoRow([{ text: "one", completed: false }, { text: "two", completed: false }], "complete");

  const ids = row?.entries.map((entry) => entry.id) ?? [];
  expect(new Set(ids).size).toBe(2);
  expect(ids.every((id) => id.length > 0)).toBe(true);
});

test("the card counts its own progress so the header never disagrees with the list", () => {
  const row = toTodoRow(
    [
      { text: "a", completed: true, status: "completed" },
      { text: "b", completed: false, status: "in_progress" },
      { text: "c", completed: false, status: "pending" },
      { text: "d", completed: true, status: "completed" },
    ],
    "complete",
  );

  expect(row?.total).toBe(4);
  expect(row?.completed).toBe(2);
});

test("an empty list produces no card rather than an empty one", () => {
  expect(toTodoRow([], "complete")).toBeNull();
});

test("a payload that is not a list produces no card instead of throwing", () => {
  expect(toTodoRow(undefined, "complete")).toBeNull();
  expect(toTodoRow({ items: "nope" }, "complete")).toBeNull();
});

test("an entry with unusable text is dropped rather than rendered blank", () => {
  const row = toTodoRow(
    [{ text: "real", completed: false }, { text: 42, completed: false }, { completed: true }],
    "complete",
  );

  expect(row?.entries).toHaveLength(1);
  expect(row?.entries[0]?.text).toBe("real");
});

test("a list whose entries are all unusable produces no card", () => {
  expect(toTodoRow([{ text: 42 }, {}], "complete")).toBeNull();
});

test("an unfamiliar status falls back to pending instead of failing the schema", () => {
  const row = toTodoRow([{ text: "a", completed: false, status: "teleported" }], "complete");

  expect(row?.entries[0]?.status).toBe("pending");
});

test("the row the renderer receives validates against the published schema", () => {
  const row = toTodoRow([{ text: "a", completed: false, status: "in_progress" }], "streaming");

  expect(() => TodoRowSchema.parse(row)).not.toThrow();
});

test("the schema rejects a status the card has no treatment for", () => {
  expect(
    TodoRowSchema.safeParse({
      entries: [{ id: "a", text: "a", status: "teleported" }],
      total: 1,
      completed: 0,
      phase: "complete",
    }).success,
  ).toBe(false);
});

test("the published kind and version are stable", () => {
  expect(TODO_ROW_KIND).toBe("omo-todo");
  expect(TODO_ROW_VERSION).toBe(1);
});

test("one todo item becomes exactly one card", () => {
  const result = todoPluginItems({ type: "todo", items: [{ text: "a", completed: false }] }, "streaming");

  expect(result?.items).toHaveLength(1);
  expect(result?.items[0]).toMatchObject({ type: "plugin", kind: TODO_ROW_KIND, version: TODO_ROW_VERSION });
});

test("the card carries no id of its own, so a streaming update keeps the same mounted row", () => {
  // Paseo derives identity from the source item when the transformer emits one
  // item. Supplying an id that changes per update would remount the card on
  // every keystroke of the turn and throw away its scroll and animation state.
  const first = todoPluginItems({ type: "todo", items: [{ text: "a", completed: false }] }, "streaming");
  const later = todoPluginItems(
    { type: "todo", items: [{ text: "a", completed: true }, { text: "b", completed: false }] },
    "streaming",
  );

  expect(first?.items[0]).not.toHaveProperty("id");
  expect(later?.items[0]).not.toHaveProperty("id");
});

test.each([
  ["null", null],
  ["a string", "todo"],
  ["a number", 7],
  ["no items key", { type: "todo" }],
  ["items as an object", { type: "todo", items: { text: "a" } }],
  ["entries that are not objects", { type: "todo", items: [null, 3, "x", []] }],
  ["a nested cycle-free mess", { type: "todo", items: [{ text: { deep: true }, completed: [] }] }],
])("a %s payload leaves the timeline alone instead of throwing", (_case, payload) => {
  // A transformer that throws is logged and skipped by Paseo, but it takes the
  // whole card with it; returning undefined keeps the built-in row on screen.
  expect(() => todoPluginItems(payload, "complete")).not.toThrow();
  expect(todoPluginItems(payload, "complete")).toBeUndefined();
});

test("a task flips pending, in_progress, then completed and every update stays the same mounted row", () => {
  // The protocol item carries one status per turn snapshot; each flip arrives as
  // a fresh streaming update of the same source item, so every emission must be
  // id-less (Paseo keeps the card mounted), schema-valid, and count the check.
  const statuses = ["pending", "in_progress", "completed"] as const;
  const flips = statuses.map((status) =>
    todoPluginItems(
      { type: "todo", items: [{ text: "wire the pump", id: "a", status, completed: status === "completed" }] },
      "streaming",
    ),
  );

  expect(flips.every((result) => result?.items[0] !== undefined && !("id" in result.items[0]))).toBe(true);
  expect(flips.map((result) => result?.items[0]?.data.completed)).toEqual([0, 0, 1]);
  expect(flips.map((result) => result?.items[0]?.data.total)).toEqual([1, 1, 1]);
  expect(flips.map((result) => result?.items[0]?.data.entries[0]?.status)).toEqual([...statuses]);
  for (const result of flips) {
    expect(() => TodoRowSchema.parse(result?.items[0]?.data)).not.toThrow();
  }
});

test("a todo item with nothing usable in it leaves the built-in row alone", () => {
  expect(todoPluginItems({ type: "todo", items: [] }, "complete")).toBeUndefined();
  expect(todoPluginItems({ type: "todo", items: [{ completed: true }] }, "complete")).toBeUndefined();
});
