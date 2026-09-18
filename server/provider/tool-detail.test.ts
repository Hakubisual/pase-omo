import { describe, expect, it } from "vitest";

import { TodoRowSchema, toTodoRow } from "../../shared/todo.js";
import { spawnedTaskId, todoItems, toolCallDetail } from "./tool-detail.js";

/**
 * The OmO `todo` tool (a senpi builtin) returns
 * `{ content: [{ type: "text", text }], details: { op, phases, storage } }`
 * where `details.phases` is the authoritative post-op state:
 * `[{ name, tasks: [{ content, status }] }]`. The ARGUMENTS only ever carry
 * the initial `list` of plain strings, so the real status of a task lives on
 * the result side — a completed todo can never show as checked unless
 * `todoItems` reads it from there.
 */

/** A realistic `tool_execution_end` result for a mid-flight list. */
function resultWith(...phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>) {
  return {
    content: [{ type: "text", text: "2 of 3 done" }],
    details: { op: "start", phases, storage: "session" },
  };
}

describe("todoItems from the tool result", () => {
  it("derives each entry's real status from the result payload", () => {
    const args = { op: "start", phase: "Build", task: "wire the pump" };
    const result = resultWith(
      { name: "Setup", tasks: [{ content: "read the spec", status: "completed" }] },
      {
        name: "Build",
        tasks: [
          { content: "wire the pump", status: "in_progress" },
          { content: "ship it", status: "pending" },
        ],
      },
    );

    expect(todoItems(args, result)).toEqual([
      { text: "Setup: read the spec", completed: true, status: "completed" },
      { text: "Build: wire the pump", completed: false, status: "in_progress" },
      { text: "Build: ship it", completed: false, status: "pending" },
    ]);
  });

  it("settles dropped work (abandoned/cancelled) as completed so the header reflects remaining work only", () => {
    // A deliberately dropped item is terminal by choice; leaving it pending
    // would keep "남은 항목" above zero on a turn that actually finished.
    const args = { op: "drop", task: "legacy exporter" };
    const result = resultWith({
      name: "Tasks",
      tasks: [
        { content: "legacy exporter", status: "abandoned" },
        { content: "cancelled poller", status: "cancelled" },
        { content: "real work", status: "completed" },
      ],
    });

    expect(todoItems(args, result)).toEqual([
      { text: "Tasks: legacy exporter", completed: true, status: "completed" },
      { text: "Tasks: cancelled poller", completed: true, status: "completed" },
      { text: "Tasks: real work", completed: true, status: "completed" },
    ]);
  });

  it("degrades an unfamiliar result status to pending instead of poisoning the card", () => {
    const result = resultWith({ name: "Tasks", tasks: [{ content: "a", status: "teleported" }] });

    expect(todoItems({ op: "view" }, result)).toEqual([
      { text: "Tasks: a", completed: false, status: "pending" },
    ]);
  });

  it("accepts a bare phases array as the result", () => {
    const phases = [{ name: "Tasks", tasks: [{ content: "a", status: "completed" }] }];

    expect(todoItems({ op: "view" }, phases)).toEqual([
      { text: "Tasks: a", completed: true, status: "completed" },
    ]);
  });

  it("skips junk entries inside a result phase instead of rendering blanks", () => {
    const result = resultWith({
      name: "Tasks",
      tasks: [
        { content: "real", status: "completed" },
        { content: "", status: "completed" },
        { status: "completed" },
        42,
        "bare string task",
      ] as unknown as Array<{ content: string; status: string }>,
    });

    expect(todoItems({ op: "view" }, result)).toEqual([
      { text: "Tasks: real", completed: true, status: "completed" },
      { text: "Tasks: bare string task", completed: false, status: "pending" },
    ]);
  });

  it("feeds the client card a schema-valid row whose counts match the entries", () => {
    const result = resultWith(
      { name: "Setup", tasks: [{ content: "read the spec", status: "completed" }] },
      { name: "Build", tasks: [{ content: "wire the pump", status: "in_progress" }] },
    );

    const row = toTodoRow(todoItems({ op: "start" }, result) ?? [], "streaming");

    expect(row?.total).toBe(2);
    expect(row?.completed).toBe(1);
    expect(() => TodoRowSchema.parse(row)).not.toThrow();
  });
});

describe("todoItems fallback to the arguments", () => {
  const args = { op: "init", list: [{ phase: "Setup", items: ["read the spec", "wire the pump"] }] };

  it("builds the pending list from the arguments when no result has arrived yet", () => {
    // tool_execution_start only has the args: the card's first paint is all
    // pending, and that is the honest reading at that moment.
    expect(todoItems(args)).toEqual([
      { text: "Setup: read the spec", completed: false, status: "pending" },
      { text: "Setup: wire the pump", completed: false, status: "pending" },
    ]);
    expect(todoItems(args, undefined)).toEqual(todoItems(args));
  });

  it.each([
    ["a string", "done: everything"],
    ["null", null],
    ["a number", 7],
    ["a result without details", { content: [{ type: "text", text: "ok" }] }],
    ["details without phases", { content: [], details: { op: "view" } }],
    ["phases that are not a list", { content: [], details: { phases: "nope" } }],
    ["phases whose entries are junk", { content: [], details: { phases: [null, 3, "x"] } }],
  ])("a %s result falls back to the arguments", (_case, result) => {
    expect(todoItems(args, result)).toEqual([
      { text: "Setup: read the spec", completed: false, status: "pending" },
      { text: "Setup: wire the pump", completed: false, status: "pending" },
    ]);
  });

  it("produces no card when neither the result nor the arguments carry a list", () => {
    expect(todoItems({ op: "view" }, { content: [], details: { op: "view", phases: [] } })).toBeUndefined();
    expect(todoItems({ op: "view" })).toBeUndefined();
    expect(todoItems(undefined, undefined)).toBeUndefined();
  });
});

/**
 * A subagent row that names no session is a dead end: the run it describes is
 * recorded under that id, and the provider announces the child session under it
 * too, so the link is the only way back to what the child did.
 */
describe("task tool detail", () => {
  it("carries the spawned task id as the child session", () => {
    const detail = toolCallDetail(
      "task",
      { category: "quick", task_summary: "Check the release notes" },
      "Started task Check the release notes (st_01a0b4c9, running). Completion is delivered.",
    );

    expect(detail).toMatchObject({
      type: "sub_agent",
      subAgentType: "quick",
      description: "Check the release notes",
      childSessionId: "st_01a0b4c9",
    });
  });

  it("takes the first id when a batch spawns several", () => {
    expect(spawnedTaskId("Started st_01a0b4c9 and st_01a0b4d0")).toBe("st_01a0b4c9");
  });

  it("leaves the field out when the result names no task", () => {
    const detail = toolCallDetail("task", { description: "no id yet" }, undefined);
    expect(detail).not.toHaveProperty("childSessionId");
    expect(spawnedTaskId("started, but nothing to key on")).toBeUndefined();
  });
});
