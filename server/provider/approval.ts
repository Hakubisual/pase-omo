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
import { omoSessionRegistry, type OmoSessionRegistry } from "./session-registry.js";

export async function listPendingApprovals(
  input: ListPendingApprovalsInput,
  context: PluginHandlerContext,
  registry: OmoSessionRegistry = omoSessionRegistry,
): Promise<ListPendingApprovalsPayload> {
  // An agent with no live session has nothing pending, which is an answer, not
  // a failure: the composer pill asks for every OmO agent it can see, including
  // closed ones, and a throw there turned an ordinary state into a console full
  // of DaemonRpcErrors and a pill stuck on its last label.
  const session = await registry.forAgent(input.agentId, context).catch(() => undefined);
  return { requests: session?.getPendingUiRequests() ?? [] };
}

export async function submitApprovalResponse(
  input: SubmitApprovalInput,
  context: PluginHandlerContext,
  registry: OmoSessionRegistry = omoSessionRegistry,
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
