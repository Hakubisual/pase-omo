import { expect, test, vi } from "vitest";

import { TODO_ROW_KIND } from "../../shared/todo.js";
import { publishTodoCard } from "./todo-card.js";
import type { OmoSessionRegistry } from "./session-registry.js";
import { OmoSession } from "./omo-session.js";
import { rememberPublishedTodo } from "./todo-memory.js";

vi.mock("./todo-memory.js", () => ({
  lastPublishedTodo: vi.fn(async () => undefined),
  rememberPublishedTodo: vi.fn(async () => undefined),
}));

const items = [
  { text: "Read", completed: true, status: "completed" as const },
  { text: "Write", completed: false, status: "in_progress" as const },
];

function harness(card: { id: string; items: typeof items } | undefined) {
  const append = vi.fn(async () => undefined);
  const acknowledgeTodoCard = vi.fn(async () => undefined);
  const registry = {
    forAgent: vi.fn(async () => ({ takeTodoCard: () => card, acknowledgeTodoCard })),
  } as unknown as OmoSessionRegistry;
  const context = { paseo: { agents: { ref: () => ({ timeline: { append } }) } } };
  return { append, registry, context, acknowledgeTodoCard };
}

const agent = { id: "agent-1", provider: "omo" } as never;

test("draws the finished list as one plugin row under the session's card id", async () => {
  const { append, registry, context, acknowledgeTodoCard } = harness({ id: "todo-agent-1", items });
  await publishTodoCard(registry, agent, context as never);
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({ type: "plugin", id: "todo-agent-1", kind: TODO_ROW_KIND }),
  );
  expect(acknowledgeTodoCard).toHaveBeenCalledWith(items);
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

test("retains an unpublished card across a failed append and an unchanged turn", async () => {
  // Exercise real session state without starting an OmO child.
  const session: OmoSession = Object.create(OmoSession.prototype);
  Object.assign(session, {
    options: { paseoSessionId: "agent-1", log: vi.fn() },
    state: {},
    activeTurnId: null,
    pendingTodoItems: items,
  });
  vi.mocked(rememberPublishedTodo).mockClear();
  session["completeTurn"](undefined);
  const append = vi.fn(async () => undefined);
  append.mockRejectedValueOnce(new Error("append failed"));
  const registry = {
    forAgent: vi.fn(async () => session),
  } as unknown as OmoSessionRegistry;
  const context = { paseo: { agents: { ref: () => ({ timeline: { append } }) } } };

  await expect(publishTodoCard(registry, agent, context as never)).rejects.toThrow("append failed");
  expect(session.takeTodoCard()?.items).toEqual(items);
  expect(session["lastTodoSignature"]).toBeUndefined();
  expect(rememberPublishedTodo).not.toHaveBeenCalled();

  session["pendingTodoItems"] = items;
  session["completeTurn"](undefined);
  await publishTodoCard(registry, agent, context as never);
  expect(append).toHaveBeenCalledTimes(2);
  expect(session.takeTodoCard()).toBeUndefined();
  expect(rememberPublishedTodo).toHaveBeenCalledTimes(1);
  expect(session["lastTodoSignature"]).toBeDefined();

  session["pendingTodoItems"] = items;
  session["completeTurn"](undefined);
  expect(session.takeTodoCard()).toBeUndefined();
});
