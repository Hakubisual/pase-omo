import { describe, expect, it } from "vitest";
import { todoPluginItems } from "./todo.js";

/**
 * The transformer runs for both phases of the same timeline item - once while
 * the turn streams and once when it completes - and an item with no id is a
 * NEW card each time, which is how one published list ended up drawn twice in
 * the chat. Pinning the plugin item to the source item's id collapses both
 * phases onto one card.
 */
describe("todoPluginItems identity", () => {
  const source = {
    id: "todo-session-1",
    items: [{ text: "first", status: "completed" }, { text: "second", status: "pending" }],
  };

  it("carries the source item's id so both phases render one card", () => {
    const streaming = todoPluginItems(source, "streaming");
    const complete = todoPluginItems(source, "complete");

    expect(streaming?.items[0]?.id).toBe("todo-session-1");
    expect(complete?.items[0]?.id).toBe("todo-session-1");
  });

  it("still emits a card when the source has no id of its own", () => {
    const anonymous = todoPluginItems({ items: source.items }, "complete");

    expect(anonymous?.items).toHaveLength(1);
    expect(anonymous?.items[0]?.data.total).toBe(2);
  });
});
