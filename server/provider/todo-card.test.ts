import { expect, test, vi } from "vitest";

import { TODO_ROW_KIND } from "../../shared/todo.js";
import { publishTodoCard } from "./todo-card.js";
import type { OmoSessionRegistry } from "./session-registry.js";

const items = [
  { text: "Read", completed: true, status: "completed" as const },
  { text: "Write", completed: false, status: "in_progress" as const },
];

function harness(card: { id: string; items: typeof items } | undefined) {
  const append = vi.fn(async () => undefined);
  const registry = {
    forAgent: vi.fn(async () => ({ takeTodoCard: () => card })),
  } as unknown as OmoSessionRegistry;
  const context = { paseo: { agents: { ref: () => ({ timeline: { append } }) } } };
  return { append, registry, context };
}

const agent = { id: "agent-1", provider: "omo" } as never;

test("draws the finished list as one plugin row under the session's card id", async () => {
  const { append, registry, context } = harness({ id: "todo-agent-1", items });
  await publishTodoCard(registry, agent, context as never);
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({ type: "plugin", id: "todo-agent-1", kind: TODO_ROW_KIND }),
  );
});

test("draws nothing when the turn left no new list", async () => {
  const { append, registry, context } = harness(undefined);
  await publishTodoCard(registry, agent, context as never);
  expect(append).not.toHaveBeenCalled();
});

test("ignores agents that are not OmO sessions", async () => {
  const { append, registry, context } = harness({ id: "todo-x", items });
  await publishTodoCard(registry, { id: "x", provider: "claude" } as never, context as never);
  expect(append).not.toHaveBeenCalled();
});
