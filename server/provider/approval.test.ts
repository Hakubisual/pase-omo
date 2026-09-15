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

function createSession(sessionId = "provider-session-1"): { process: MockProcessInstance; session: OmoSession } {
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
    emit: vi.fn(),
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  const process = processState.instances.at(-1);
  if (!process) throw new Error("Missing mocked OmO process");
  return { process, session };
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
