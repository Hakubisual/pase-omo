import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, expect, it, vi } from "vitest";
import type { OmoEvent } from "./omo-process.js";
import { OmoSession } from "./omo-session.js";
import { liveTasks } from "../dag/live-tasks.js";

const wire = vi.hoisted(() => ({ emit: (_event: OmoEvent): void => {} }));
vi.mock("./omo-process.js", () => ({
  OmoProcess: class {
    constructor(options: { onEvent(event: OmoEvent): void }) { wire.emit = options.onEvent; }
    start(): void {}
    stop(): void {}
    notify(): void {}
  },
}));

const sessions: OmoSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

function fixture(sessionFile?: string) {
  const events: ProviderEvent[] = [];
  const session = new OmoSession({
    paseoSessionId: "events-test",
    ...(sessionFile === undefined ? {} : { sessionFile }),
    launch: { command: "omo", base: [], origin: "test" },
    config: { cwd: "E:/workspace", env: {}, mcpServers: {}, settings: {}, persist: false },
    capabilities: ["permission"],
    emit: (event) => events.push(event),
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  return { session, events };
}

it("reports a streaming abort once as canceled even when idle follows", () => {
  const { events } = fixture();
  wire.emit({ type: "agent_start" });
  wire.emit({ type: "agent_end", aborted: true, abortSource: "user", willRetry: false });
  wire.emit({ type: "agent_idle" });
  expect(events.filter((event) => event.type === "session.turn").map((event) => event.state))
    .toEqual(["started", "canceled"]);
});

it("keeps a retrying turn open instead of treating its abort as terminal", () => {
  const { events } = fixture();
  wire.emit({ type: "agent_start" });
  wire.emit({ type: "agent_end", aborted: true, willRetry: true });
  expect(events.filter((event) => event.type === "session.turn").map((event) => event.state))
    .toEqual(["started"]);
});

it("removes a question resolved by the runtime without sending another answer", () => {
  const { session, events } = fixture();
  wire.emit({ type: "extension_ui_request", id: "q1", method: "question", questions: [
    { id: "target", header: "Target", question: "Target?", options: [{ label: "A" }], multiSelect: false },
  ] });
  wire.emit({ type: "question_resolved", id: "q1", outcome: "timeout", answers: {}, unanswered: ["target"] });
  expect(session.getPendingUiRequests()).toEqual([]);
  expect(events.filter((event) => event.type === "session.permission_resolved"))
    .toEqual([{ type: "session.permission_resolved", sessionId: "events-test", permissionId: "q1" }]);
});

it("updates the native priority setting from a service-tier event", () => {
  const { session } = fixture();
  wire.emit({ type: "service_tier_changed", tier: "priority", fastMode: true });
  expect(session.configState().settings).toContainEqual({ type: "toggle", id: "fastMode", label: "Priority tier", value: true });
  wire.emit({ type: "service_tier_changed", fastMode: false });
  expect(session.configState().settings).toContainEqual({ type: "toggle", id: "fastMode", label: "Priority tier", value: false });
});

it("refreshes native slash commands when the runtime command surface changes", () => {
  const { events } = fixture();
  wire.emit({ type: "commands_changed", commands: [
    { name: "inspect", description: "Inspect", syntax: "slash" },
    { name: "skill-token", syntax: "dollar" },
  ] });
  expect(events.filter((event) => event.type === "session.commands"))
    .toEqual([{ type: "session.commands", sessionId: "events-test", commands: [{ name: "inspect", description: "Inspect" }] }]);
});

it("replaces durable identity and clears old questions and live tasks", () => {
  const { session, events } = fixture("E:/sessions/old.jsonl");
  wire.emit({ type: "session_replaced", durableSessionId: "old", sessionFile: "E:/sessions/old.jsonl", cwd: "E:/workspace" });
  wire.emit({ type: "extension_event", name: "omo.task.updated", data: {
    parent_session_id: "old", tasks: [{ task_id: "st_old", status: "running" }],
  } });
  wire.emit({ type: "extension_ui_request", id: "old-question", method: "confirm", title: "Continue?" });
  wire.emit({ type: "session_replaced", durableSessionId: "new", sessionFile: "E:/sessions/new.jsonl", cwd: "E:/workspace" });
  expect(session.durableSessionFile).toBe("E:/sessions/new.jsonl");
  expect(session.getPendingUiRequests()).toEqual([]);
  expect(liveTasks.records("E:/workspace")).toEqual([]);
  expect(events).toContainEqual({ type: "session.persistence", sessionId: "events-test", persistence: { version: 1, data: { sessionFile: "E:/sessions/new.jsonl" } } });
  wire.emit({ type: "extension_event", name: "omo.task.updated", data: {
    parent_session_id: "new", tasks: [{ task_id: "st_new", status: "running" }],
  } });
  expect(liveTasks.records("E:/workspace").map((entry) => entry.raw.task_id)).toEqual(["st_new"]);
});

it("does not reuse the old session file when replacement is deferred", () => {
  const { session } = fixture("E:/sessions/old.jsonl");
  wire.emit({ type: "session_replaced", durableSessionId: "deferred", cwd: "E:/workspace" });
  expect(session.durableSessionFile).toBeUndefined();
});
