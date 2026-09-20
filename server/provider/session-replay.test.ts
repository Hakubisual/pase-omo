import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, expect, it, vi } from "vitest";
import { OmoSession } from "./omo-session.js";

const history = vi.hoisted(() => ({
  messages: [] as unknown[],
  call: vi.fn(),
  lastPublishedTodo: vi.fn(),
  rememberPublishedTodo: vi.fn(),
}));

vi.mock("./omo-process.js", () => ({
  OmoProcess: class {
    readonly whenExited = Promise.resolve();
    start(): void {}
    stop(): void {}
    call = history.call;
  },
}));
vi.mock("./todo-memory.js", () => ({
  lastPublishedTodo: history.lastPublishedTodo,
  rememberPublishedTodo: history.rememberPublishedTodo,
}));

const sessions: OmoSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.resetAllMocks();
  history.messages = [];
});

const call = (id: string, name: string, args: unknown = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const result = (toolCallId: string, text: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult", toolCallId, content: [{ type: "text", text }], isError: false, ...extra,
});
const phases = (status: string) => [{ name: "Build", tasks: [{ content: "Ship", status }] }];

async function replay(messages: unknown[]) {
  history.messages = messages;
  history.call.mockImplementation(async (command: string) => {
    switch (command) {
      case "get_state": return { sessionId: "native-session", sessionFile: "E:/sessions/native.jsonl" };
      case "get_available_models": return { models: [] };
      case "get_commands": return { commands: [] };
      case "get_messages": return { messages: history.messages };
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
  const events: ProviderEvent[] = [];
  const session = new OmoSession({
    paseoSessionId: "replay-session",
    launch: { command: "omo", base: [], origin: "test" },
    config: { cwd: "E:/workspace", env: {}, mcpServers: {}, settings: {}, persist: true },
    capabilities: [],
    emit: event => events.push(event),
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  await session.open("open-replay", "replay");
  expect(history.call).toHaveBeenCalledWith("get_messages", {}, 60_000);
  return events.filter(event => event.type === "timeline.item").map(event => event.item);
}

it("joins out-of-order tool results by call id, retaining output, failure, and child links", async () => {
  const items = await replay([
    { role: "user", content: "Run checks" },
    assistant({ type: "text", text: "Checking" },
      call("shell", "bash", { command: "check" }),
      call("child", "task", { description: "Audit" }),
      call("read", "read", { path: "file.txt" })),
    result("read", "file contents"),
    result("child", "Started task (st_01a0bdfb, running)"),
    result("shell", "check failed", { isError: true }),
    assistant(call("shell-ok", "bash", { command: "verify" })),
    result("shell-ok", "verified"),
  ]);
  expect(items.filter(item => item.type === "tool_call")).toMatchObject([
    { callId: "shell", status: "failed", error: "check failed", detail: { type: "shell", output: "check failed" } },
    { callId: "child", status: "completed", error: null, detail: { type: "sub_agent", childSessionId: "st_01a0bdfb", log: "Started task (st_01a0bdfb, running)" } },
    { callId: "read", status: "completed", detail: { type: "read", content: "file contents" } },
    { callId: "shell-ok", status: "completed", detail: { output: "verified" } },
  ]);
  expect(items.filter(item => item.type === "user_message" || item.type === "assistant_message")).toHaveLength(2);
});

it("does not invent success for an unmatched tool call", async () => {
  const items = await replay([assistant(call("unfinished", "bash", { command: "check" }))]);
  expect(items).toMatchObject([{ type: "tool_call", callId: "unfinished", status: "running", error: null }]);
});

it("replays only the latest authoritative todo result, not arguments or intermediate snapshots", async () => {
  const finalItems = [{ text: "Build: Ship", completed: true, status: "completed" }];
  const signature = JSON.stringify([["Build: Ship", "completed"]]);
  // Reconstruct history even when the prior process already remembered this card.
  history.lastPublishedTodo.mockResolvedValue(signature);
  const items = await replay([
    assistant(call("todo-first", "todo", { list: [{ phase: "Old", items: ["Stale"] }] })),
    result("todo-first", "pending", { details: { phases: phases("pending") } }),
    assistant(call("todo-progress", "todo"), call("todo-final", "todo")),
    result("todo-progress", "working", { details: { phases: phases("in_progress") } }),
    result("todo-final", "done", { details: { phases: phases("completed") } }),
    assistant(call("todo-bad", "todo", { list: [{ phase: "Wrong", items: ["Ignore"] }] })),
    result("todo-bad", "malformed", { details: { phases: [{}] } }),
    assistant(call("todo-failed", "todo")),
    result("todo-failed", "failed", { isError: true, details: { phases: [] } }),
  ]);
  expect(items.filter(item => item.type === "todo")).toEqual([
    { type: "todo", id: "todo-replay-session", items: finalItems },
  ]);
  expect(history.rememberPublishedTodo).toHaveBeenCalledWith("e:/sessions/native.jsonl", signature);
});

it.each([{ finalPhases: [] }, { finalPhases: [{ name: "Build", tasks: [] }] }])("restores a final valid empty todo state (%j)", async ({ finalPhases }) => {
  const items = await replay([
    assistant(call("todo-first", "todo")),
    result("todo-first", "pending", { details: { phases: phases("pending") } }),
    assistant(call("todo-clear", "todo", { list: [{ phase: "Old", items: ["Stale"] }] })),
    result("todo-clear", "cleared", { details: { phases: finalPhases } }),
  ]);
  expect(items.filter(item => item.type === "todo")).toEqual([
    { type: "todo", id: "todo-replay-session", items: [] },
  ]);
  expect(history.rememberPublishedTodo).toHaveBeenCalledWith("e:/sessions/native.jsonl", "[]");
});
