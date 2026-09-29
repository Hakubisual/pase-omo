import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listPendingApprovalsRpc, submitApprovalResponseRpc } from "../../shared/approval.js";
import {
  listPendingApprovals,
  registerApprovalHandlers,
  submitApprovalResponse,
} from "./approval.js";
import { OmoSession } from "./omo-session.js";

interface MockProcessInstance {
  emit(event: Record<string, unknown>): void;
  notify: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const processState = vi.hoisted(() => ({
  instances: [] as MockProcessInstance[],
}));

vi.mock("./omo-process.js", () => {
  class OmoProcess {
    readonly notify = vi.fn();
    readonly stop = vi.fn();
    private readonly onEvent: (event: Record<string, unknown>) => void;

    constructor(options: { onEvent(event: Record<string, unknown>): void }) {
      this.onEvent = options.onEvent;
      processState.instances.push(this);
    }

    emit(event: Record<string, unknown>): void {
      this.onEvent(event);
    }

    start(): void {}

    async call<T>(): Promise<T> {
      return {} as T;
    }
  }

  return { OmoProcess };
});

const sessions: OmoSession[] = [];

function createSession(sessionId = "provider-session-1"): {
  process: MockProcessInstance;
  session: OmoSession;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  const session = new OmoSession({
    paseoSessionId: sessionId,
    launch: { command: "omo", base: [], origin: "test" },
    config: {
      cwd: "E:/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    capabilities: ["permission"],
    emit,
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  const process = processState.instances.at(-1);
  if (!process) throw new Error("Missing mocked OmO process");
  return { process, session, emit };
}

function context(agentId: string, runtimeSessionId = "provider-session-1"): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: vi.fn(() => ({
          current: () => ({ id: agentId, runtimeInfo: { sessionId: runtimeSessionId } }),
          refresh: vi.fn(),
        })),
      },
    },
  } as unknown as PluginHandlerContext;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  processState.instances.length = 0;
  vi.clearAllMocks();
});

describe("approval RPC handlers", () => {
  it("lists confirm, select, and question requests for the live agent session", async () => {
    const { process } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Apply changes?",
      message: "The files will be updated.",
    });
    process.emit({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "Choose environment",
      options: ["Staging", "Production"],
    });
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "deploy_region",
          header: "Region",
          question: "Which region should be used?",
          options: [{ label: "Use nearest" }],
          multiSelect: false,
        },
      ],
    });

    await expect(listPendingApprovals({ agentId: "agent-1" }, context("agent-1"))).resolves.toEqual({
      requests: [
        { id: "confirm-1", method: "confirm", title: "Apply changes?", options: [] },
        {
          id: "select-1",
          method: "select",
          title: "Choose environment",
          options: [
            { action: "option-0", label: "Staging" },
            { action: "option-1", label: "Production" },
          ],
        },
        {
          id: "question-1",
          method: "question",
          title: "Which region should be used?",
          options: [{ action: "option-0", label: "Use nearest" }],
          questionKey: "deploy_region",
        },
      ],
    });
  });

  it("answers an agent with no live session with an empty list", async () => {
    // The composer pill asks for every OmO agent the host lists, including ones
    // whose session is closed. Throwing there filled the console with
    // DaemonRpcErrors and froze the pill on its last label; having nothing
    // pending is an answer.
    await expect(
      listPendingApprovals({ agentId: "agent-gone" }, context("agent-gone", "no-such-session")),
    ).resolves.toEqual({ requests: [] });
  });

  it("puts a free-text answer under the pending question key", async () => {
    const { process } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "deploy_region",
          header: "Region",
          question: "Which region should be used?",
          options: [],
          multiSelect: false,
        },
      ],
    });

    await expect(
      submitApprovalResponse(
        {
          agentId: "agent-1",
          requestId: "question-1",
          response: { behavior: "allow", answer: "ap-northeast-2" },
        },
        context("agent-1"),
      ),
    ).resolves.toEqual({ submitted: true });

    expect(process.notify).toHaveBeenCalledTimes(1);
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-1",
      answers: {
        deploy_region: { selected: [], text: "ap-northeast-2" },
      },
    });
  });

  it("rejects an unknown request id instead of silently ignoring it", async () => {
    createSession();

    await expect(
      submitApprovalResponse(
        {
          agentId: "agent-1",
          requestId: "missing-request",
          response: { behavior: "deny" },
        },
        context("agent-1"),
      ),
    ).rejects.toThrow(/Unknown pending OmO UI request: missing-request/);
  });

  it("gives Paseo's question card every question and maps its answers back by id", () => {
    // Paseo draws a kind:"question" permission from request.input alone; without
    // it the card rendered empty with no way to answer.
    const { process, session, emit } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          options: [{ label: "Seoul", description: "ap-northeast-2" }, { label: "Tokyo" }],
          multiSelect: false,
        },
        {
          id: "checks",
          header: "Checks",
          question: "Which checks?",
          options: [{ label: "Lint" }, { label: "Unit, fast" }, { label: "E2E" }],
          multiSelect: true,
        },
        { id: "notes", header: "Region", question: "Anything else?", options: [], multiSelect: false },
      ],
    });

    const permission = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session.permission");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Which region?",
          header: "Region",
          options: [{ label: "Seoul", description: "ap-northeast-2" }, { label: "Tokyo" }],
          multiSelect: false,
          allowOther: true,
        },
        {
          question: "Which checks?",
          header: "Checks",
          options: [{ label: "Lint" }, { label: "Unit, fast" }, { label: "E2E" }],
          multiSelect: true,
          allowOther: true,
        },
        { question: "Anything else?", header: "Region (2)", options: [], multiSelect: false, allowOther: true },
      ],
    });

    // The card's submission: the request input plus one string per header.
    session.respondToPermission("question-1", {
      behavior: "allow",
      updatedInput: {
        ...permission.request.input,
        answers: { Region: "Seoul", Checks: "Lint, Unit, fast, also smoke", "Region (2)": "ship it" },
      },
    });

    expect(process.notify).toHaveBeenCalledTimes(1);
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-1",
      answers: {
        region: { selected: ["Seoul"] },
        checks: { selected: ["Lint", "Unit, fast"], text: "also smoke" },
        notes: { selected: [], text: "ship it" },
      },
    });
  });

  it("gives Paseo's question card every select option and returns the chosen label as the value", () => {
    const { process, session, emit } = createSession();
    const options = ["A", "B", "C", "D", "E", "F", "G", "H", "Production"];
    process.emit({ type: "extension_ui_request", id: "select-1", method: "select", title: "Choose environment", options });

    const permission = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session.permission");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Choose environment",
          header: "Choice",
          options: options.map((label) => ({ label })),
          multiSelect: false,
          allowOther: false,
        },
      ],
    });

    session.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { ...permission.request.input, answers: { Choice: "Production" } },
    });
    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-1", value: "Production" });
  });

  it("cancels a select the card answers with a value OmO never offered", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "select-1", method: "select", title: "Pick", options: ["A", "B"] });

    session.respondToPermission("select-1", { behavior: "allow", updatedInput: { answers: { Choice: "Z" } } });

    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-1", cancelled: true });
  });

  it("cancels a question the card submits with no answers instead of leaving OmO waiting", () => {
    const { process, session } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [{ id: "region", header: "Region", question: "Which region?", options: [], multiSelect: false }],
    });

    session.respondToPermission("question-1", { behavior: "allow", updatedInput: { answers: {} } });

    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "question-1", cancelled: true });
  });

  it("preserves a question id that is also an Object prototype key", () => {
    // Given an OmO question with an unrestricted string id.
    const { process, session } = createSession();
    process.emit({
      type: "extension_ui_request", id: "prototype-question", method: "question",
      questions: [{ id: "__proto__", header: "Choice", question: "Pick", options: [{ label: "A" }] }],
    });

    // When the native card submits its answer.
    session.respondToPermission("prototype-question", {
      behavior: "allow", updatedInput: { answers: { Choice: "A" } },
    });

    // Then the answer remains an own JSON key rather than changing the map prototype.
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response", id: "prototype-question",
      answers: { ["__proto__"]: { selected: ["A"] } },
    });
  });

  it.each([undefined, {}, { answers: [] }])("cancels a select without a valid card answer (%j)", (updatedInput) => {
    // Given a pending native selection with no legacy action chosen.
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "select-empty", method: "select", options: ["A"] });

    // When an empty or malformed submission crosses the permission boundary.
    session.respondToPermission("select-empty", {
      behavior: "allow", ...(updatedInput ? { updatedInput } : {}),
    });

    // Then OmO receives cancellation, never a value it did not offer.
    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-empty", cancelled: true });
  });

  it("registers both approval RPC handlers for entry wiring", () => {
    const contracts: string[] = [];
    const server = {
      handle: vi.fn((contract) => {
        contracts.push(contract.name);
      }),
    } as unknown as Pick<PluginServerContext, "handle">;

    const cleanup = registerApprovalHandlers(server);

    expect(contracts).toEqual([listPendingApprovalsRpc.name, submitApprovalResponseRpc.name]);
    expect(typeof cleanup).toBe("function");
  });
});
