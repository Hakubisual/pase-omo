import type { RpcInput } from "@getpaseo/plugin";
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
 * A chat knows its Paseo agent, not an OmO session, so the daemon reads the
 * agent record for the workspace and session behind it and then resolves
 * ownership from there.
 */
export async function locateDag(input: RpcInput<typeof locateDagRpc>): Promise<LocateDagPayload> {
  let cwd = input.cwd;
  let sessionId = input.sessionId;
  if (input.agentId !== undefined && (cwd === undefined || sessionId === undefined)) {
    const origin = await resolveAgent(input.agentId);
    cwd = cwd ?? origin.cwd ?? undefined;
    sessionId = sessionId ?? origin.sessionId ?? undefined;
  }
  if (cwd === undefined) {
    return { destination: null, reason: "This conversation has no recorded OmO workspace yet." };
  }
  return locateDagDestination({
    cwd,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
}
