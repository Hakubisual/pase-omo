import { describe, expect, it } from "vitest";
import { finalTodoPublication, holdTodo } from "./todo-publish.js";

/**
 * Every publication of a todo item becomes its own timeline row, so the card is
 * drawn once per turn - in the state the turn ended in. Live progress is not
 * lost: Paseo shows the running task count in the composer while the turn works.
 */
const items = (...statuses: Array<"pending" | "in_progress" | "completed">) =>
  statuses.map((status, index) => ({ text: `task-${index}`, completed: status === "completed", status }));

describe("holdTodo", () => {
  it("never draws during the turn", () => {
    expect(holdTodo(items("pending", "pending")).publish).toBe(false);
  });

  it("keeps the list it was given for the end of the turn", () => {
    expect(holdTodo(items("completed", "pending")).items).toEqual(items("completed", "pending"));
  });
});

describe("finalTodoPublication", () => {
  it("draws the state the turn ended in", () => {
    const held = holdTodo(items("completed", "in_progress"));
    const final = finalTodoPublication(undefined, held.items);

    expect(final.publish).toBe(true);
    expect(final.items).toEqual(items("completed", "in_progress"));
  });

  it("draws nothing for a turn that never touched a list", () => {
    expect(finalTodoPublication(undefined, undefined).publish).toBe(false);
  });

  it("draws nothing when the turn ended on the card already shown", () => {
    const held = holdTodo(items("completed", "completed"));
    const first = finalTodoPublication(undefined, held.items);

    expect(finalTodoPublication(first.signature, held.items).publish).toBe(false);
  });
});
