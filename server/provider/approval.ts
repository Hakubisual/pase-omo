import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

import {
  listPendingApprovalsRpc,
  submitApprovalResponseRpc,
  type ListPendingApprovalsInput,
  type ListPendingApprovalsPayload,
  type SubmitApprovalInput,
  type SubmitApprovalPayload,
} from "../../shared/approval.js";
import type { OmoSession } from "./omo-session.js";

type ApprovalSession = Pick<
  OmoSession,
  "durableSessionFile" | "getPendingUiRequests" | "respondToUiRequest" | "sessionId"
>;

function normalizedFile(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function sessionFileFromRuntime(runtimeSessionId: string): string | undefined {
  const objectStart = runtimeSessionId.indexOf("{");
  if (objectStart < 0) return undefined;
  try {
    const parsed = JSON.parse(runtimeSessionId.slice(objectStart)) as {
      data?: { sessionFile?: unknown };
    };
    return typeof parsed.data?.sessionFile === "string" ? parsed.data.sessionFile : undefined;
  } catch {
    return undefined;
  }
}

/** Live OmO sessions are registered by OmoSession construction and removed on close. */
export class ApprovalSessionRegistry {
  private readonly sessions = new Set<ApprovalSession>();

  add(session: ApprovalSession): () => void {
    this.sessions.add(session);
    return () => {
      this.sessions.delete(session);
    };
  }

  private matchingSession(agentId: string, runtimeSessionId?: string): ApprovalSession | undefined {
    for (const session of this.sessions) {
      if (session.sessionId === agentId || session.sessionId === runtimeSessionId) return session;
    }

    if (!runtimeSessionId) return undefined;
    const runtimeFile = sessionFileFromRuntime(runtimeSessionId);
    if (!runtimeFile) return undefined;
    const expected = normalizedFile(runtimeFile);
    return [...this.sessions].find(
      (session) => session.durableSessionFile !== undefined && normalizedFile(session.durableSessionFile) === expected,
    );
  }

  async forAgent(agentId: string, context: PluginHandlerContext): Promise<ApprovalSession> {
    const direct = this.matchingSession(agentId);
    if (direct) return direct;

    const handle = context.paseo.agents.ref(agentId);
    let agent = handle.current();
    if (!agent?.runtimeInfo?.sessionId) agent = (await handle.refresh())?.agent ?? agent;
    const runtimeSessionId = agent?.runtimeInfo?.sessionId ?? undefined;
    const session = this.matchingSession(agentId, runtimeSessionId);
    if (!session) throw new Error(`No live OmO session for agent: ${agentId}`);
    return session;
  }
}

export const approvalSessionRegistry = new ApprovalSessionRegistry();

export async function listPendingApprovals(
  input: ListPendingApprovalsInput,
  context: PluginHandlerContext,
  registry: ApprovalSessionRegistry = approvalSessionRegistry,
): Promise<ListPendingApprovalsPayload> {
  const session = await registry.forAgent(input.agentId, context);
  return { requests: session.getPendingUiRequests() };
}

export async function submitApprovalResponse(
  input: SubmitApprovalInput,
  context: PluginHandlerContext,
  registry: ApprovalSessionRegistry = approvalSessionRegistry,
): Promise<SubmitApprovalPayload> {
  const session = await registry.forAgent(input.agentId, context);
  session.respondToUiRequest(input.requestId, input.response);
  return { submitted: true };
}

/** Entry-point wiring: registers both approval RPC contracts. */
export function registerApprovalHandlers(plugin: Pick<PluginServerContext, "handle">): PluginCleanup {
  plugin.handle(listPendingApprovalsRpc, listPendingApprovals);
  plugin.handle(submitApprovalResponseRpc, submitApprovalResponse);
  return () => {};
}
