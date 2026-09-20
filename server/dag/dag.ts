import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  getSnapshotRpc,
  listSessionsRpc,
  type DagSessionsPayload,
  type DagSnapshotPayload,
} from "../../shared/dag.js";
import { locateDagRpc, type LocateDagPayload } from "../../shared/navigate.js";
import { resolveAgent } from "../chat/runs.js";
import { getDagSnapshot, listDagSessions, locateDagDestination } from "./dag-store.js";

export async function listSessions(input: RpcInput<typeof listSessionsRpc>): Promise<DagSessionsPayload> {
  return { sessions: await listDagSessions({ cwd: input.cwd }) };
}

export async function getSnapshot(input: RpcInput<typeof getSnapshotRpc>): Promise<DagSnapshotPayload> {
  return getDagSnapshot({ cwd: input.cwd, sessionId: input.sessionId });
}

/**
 * Where an "Open in OmO DAG" action should land.
 *
 * A chat knows its Paseo agent, not an OmO session, so the daemon fetches the
 * SDK snapshot for the workspace and session behind it and then resolves
 * ownership from there.
 */
export async function locateDag(
  input: RpcInput<typeof locateDagRpc>,
  context: PluginHandlerContext,
): Promise<LocateDagPayload> {
  let cwd = input.cwd;
  let sessionId = input.sessionId;
  let sessionFile: string | undefined;
  if (input.agentId !== undefined) {
    const origin = await resolveAgent(input.agentId, context);
    cwd = cwd ?? origin.cwd ?? undefined;
    sessionId = sessionId ?? origin.sessionId ?? undefined;
    sessionFile = origin.sessionFile;
    if (sessionId === undefined) {
      return { destination: null, reason: "이 대화의 OmO 세션을 아직 확인할 수 없습니다." };
    }
  }
  if (cwd === undefined) {
    return { destination: null, reason: "이 대화에 기록된 OmO 워크스페이스가 아직 없습니다." };
  }
  return locateDagDestination({
    cwd,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionFile === undefined ? {} : { sessionFile }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
}
