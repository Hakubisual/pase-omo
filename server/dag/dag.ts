import type { RpcInput } from "@getpaseo/plugin";
import {
  getSnapshotRpc,
  listSessionsRpc,
  type DagSessionsPayload,
  type DagSnapshotPayload,
} from "../../shared/dag.js";
import { getDagSnapshot, listDagSessions } from "./dag-store.js";

export async function listSessions(input: RpcInput<typeof listSessionsRpc>): Promise<DagSessionsPayload> {
  return { sessions: await listDagSessions({ cwd: input.cwd }) };
}

export async function getSnapshot(input: RpcInput<typeof getSnapshotRpc>): Promise<DagSnapshotPayload> {
  return getDagSnapshot({ cwd: input.cwd, sessionId: input.sessionId });
}
