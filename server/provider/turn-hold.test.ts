import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OmoSession } from "./omo-session.js";

interface MockProcessInstance {
  emit(event: Record<string, unknown>): void;
  call: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  instances: [] as MockProcessInstance[],
  getState: (async () => ({})) as () => Promise<unknown>,
  readTaskRecords: vi.fn(async (): Promise<unknown[]> => []),
  readOpenWork: vi.fn(async (): Promise<unknown[] | "unreadable"> => []),
}));

vi.mock("./omo-process.js", () => {
  class OmoProcess {
    readonly notify = vi.fn();
    readonly stop = vi.fn();
    readonly call = vi.fn(async (command: string) => (command === "get_state" ? mocks.getState() : {}));
    private readonly onEvent: (event: Record<string, unknown>) => void;

    constructor(options: { onEvent(event: Record<string, unknown>): void }) {
      this.onEvent = options.onEvent;
      mocks.instances.push(this);
    }

    emit(event: Record<string, unknown>): void {
      this.onEvent(event);
    }

    start(): void {}
  }

  return { OmoProcess };
});

vi.mock("./task-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./task-watch.js")>()),
  readTaskRecords: mocks.readTaskRecords,
}));

vi.mock("./background-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./background-watch.js")>()),
  readOpenWork: mocks.readOpenWork,
}));

const PARENT = "provider-session-1";
const sessions: OmoSession[] = [];

function createSession() {
  const emit = vi.fn();
  const session = new OmoSession({
    paseoSessionId: PARENT,
    launch: { command: "omo", base: [], origin: "test" },
    config: { cwd: "E:/workspace", env: {}, mcpServers: {}, settings: {}, persist: true },
    capabilities: ["permission"],
    emit,
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  session["state"] = { sessionId: "omo-1", cwd: "E:/workspace" };
  sessions.push(session);
  const process = mocks.instances.at(-1);
  if (!process) throw new Error("Missing mocked OmO process");
  return { process, session, emit };
}

type Emit = ReturnType<typeof vi.fn>;

function events(emit: Emit): Array<Record<string, unknown>> {
  return emit.mock.calls.map(([event]) => event as Record<string, unknown>);
}

function parentTurns(emit: Emit): unknown[] {
  return events(emit)
    .filter((event) => event.type === "session.turn" && event.sessionId === PARENT)
    .map((event) => event.state);
}

function wake(process: MockProcessInstance, source: string, activeCount: number, ids: string[] = []): void {
  process.emit({
    type: "extension_event",
    name: "wake_source_state",
    data: { source, activeCount, items: ids.map((id) => ({ id, description: `cell ${id}` })) },
  });
}

beforeEach(() => {
  mocks.getState = async () => ({});
  mocks.readTaskRecords.mockImplementation(async () => []);
  mocks.readOpenWork.mockImplementation(async () => []);
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  mocks.instances.length = 0;
  vi.clearAllMocks();
});

describe("a turn held open by background work", () => {
  it("stays open while a codemode cell is outstanding and completes once it ends", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    wake(process, "senpi-codemode", 1, ["cell-1"]);
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);
    expect(events(emit)).toContainEqual(
      expect.objectContaining({ type: "session.opened", sessionId: "cell-1", parentSessionId: PARENT }),
    );

    wake(process, "senpi-codemode", 0);
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open while a task record is not terminal, and still opens the task child", async () => {
    mocks.readTaskRecords.mockImplementation(async () => [
      { task_id: "st_1", status: "running", parent_session_id: "omo-1", description: "audit" },
    ]);
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];
    await session["scanTasks"]();
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);
    expect(events(emit)).toContainEqual(
      expect.objectContaining({ type: "session.opened", sessionId: "st_1", parentSessionId: PARENT }),
    );

    mocks.readTaskRecords.mockImplementation(async () => [
      { task_id: "st_1", status: "completed", parent_session_id: "omo-1", description: "audit" },
    ]);
    await session["scanTasks"]();
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open while open work cannot be read, and completes once it can", async () => {
    mocks.readOpenWork.mockImplementation(async () => "unreadable");
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);

    mocks.readOpenWork.mockImplementation(async () => []);
    wake(process, "senpi-codemode", 0);
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open when get_state fails", async () => {
    mocks.getState = async () => {
      throw new Error("get_state timed out");
    };
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);
  });

  it("stays open while the agent still reports itself busy", async () => {
    mocks.getState = async () => ({ isBashRunning: true });
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_idle" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);
  });

  it("keeps the turn id and does not settle when the agent will retry", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end", willRetry: true });

    expect(session["activeTurnId"]).toBe("turn-1");
    expect(session["pendingSettle"]).toBeUndefined();
    expect(parentTurns(emit)).toEqual(["started"]);
  });

  it("is canceled by session_abort, and a late probe cannot complete it", async () => {
    let release: (value: unknown) => void = () => undefined;
    mocks.getState = () => new Promise((resolve) => (release = resolve));
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    const settling = session["pendingSettle"];
    process.emit({ type: "session_abort" });
    release({});
    await settling;

    expect(parentTurns(emit)).toEqual(["started", "canceled"]);
  });

  it("draws the todo card once, on the real completion, and never as a timeline todo item", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "todo",
      args: { list: [{ phase: "Build", items: ["write code"] }] },
    });
    wake(process, "senpi-codemode", 1, ["cell-1"]);
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(session.takeTodoCard()).toBeUndefined();

    wake(process, "senpi-codemode", 0);
    await session["pendingSettle"];

    expect(session.takeTodoCard()?.items).toHaveLength(1);
    const items = events(emit).flatMap((event) => (event.type === "timeline.item" ? [event.item as { type: string }] : []));
    expect(items.map((item) => item.type)).not.toContain("todo");
  });

  it("holds for a monitor and completes when the monitor list empties", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({
      type: "extension_event",
      name: "terminal_monitor_state",
      data: { activeCount: 1, monitors: [{ id: "mon-1", description: "tail logs" }] },
    });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);
    expect(events(emit)).toContainEqual(
      expect.objectContaining({ type: "session.opened", sessionId: "mon-1", parentSessionId: PARENT }),
    );

    process.emit({ type: "extension_event", name: "terminal_monitor_state", data: { activeCount: 0, monitors: [] } });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("completes immediately when nothing is outstanding", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open while an ask-user question is unanswered", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [{ id: "region", header: "Region", question: "Which?", options: [{ label: "Nearest" }] }],
    });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);

    session.respondToUiRequest("question-1", { behavior: "allow", action: "option-0" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open while get_state still lists a pending question", async () => {
    mocks.getState = async () => ({ pendingQuestions: [{ id: "q" }] });
    const { process, session, emit } = createSession();
    process.emit({ type: "agent_start" });
    process.emit({ type: "agent_end" });
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started"]);

    mocks.getState = async () => ({ pendingQuestions: [] });
    wake(process, "senpi-codemode", 0);
    await session["pendingSettle"];

    expect(parentTurns(emit)).toEqual(["started", "completed"]);
  });

  it("stays open while a background bash session is in the terminal sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-hold-bash-"));
    const sessionFile = join(root, "stamp_omo-1.jsonl");
    const sidecar = join(root, "extensions", "terminal", `${encodeURIComponent("omo-1")}.json`);
    await mkdir(join(root, "extensions", "terminal"), { recursive: true });
    await writeFile(
      sidecar,
      JSON.stringify({ backgroundSessions: [{ id: "bash-1", command: "sleep 30", startedAtMs: 1 }] }),
    );
    mocks.getState = async () => ({ sessionFile, sessionId: "omo-1" });
    try {
      const { process, session, emit } = createSession();
      process.emit({ type: "agent_start" });
      process.emit({ type: "agent_end" });
      await session["pendingSettle"];

      expect(parentTurns(emit)).toEqual(["started"]);
      expect(emit.mock.calls.map(([event]) => event)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "session.opened", sessionId: "bash-1" })]),
      );

      await rm(sidecar);
      wake(process, "senpi-codemode", 0);
      await session["pendingSettle"];
      expect(parentTurns(emit)).toEqual(["started", "completed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
