import type { RpcInput } from "@getpaseo/plugin";
import type { DagRow, activeRunsRpc } from "../../shared/row";
import { readRows, resolveAgent } from "./runs";

/** Runs older than this never reach the pill, even when they are the newest on disk. */
const WINDOW_MS = 6 * 60 * 60 * 1000;
/** The pill only ever needs the newest handful. */
const MAX_ROWS = 5;

/**
 * Agents whose first pill query was already logged; the pill asks repeatedly
 * while a run is live, and one line per agent is enough.
 *
 * The daemon outlives every agent it hosts, so this is capped and evicted in
 * insertion order: a long-lived daemon re-logs an agent it has not seen in a
 * long time instead of holding every id it ever saw.
 */
const ANNOUNCE_LIMIT = 256;
const announced = new Set<string>();

function announceOnce(agentId: string, line: string): void {
  if (announced.has(agentId)) return;
  if (announced.size >= ANNOUNCE_LIMIT) {
    const oldest = announced.values().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }
  announced.add(agentId);
  console.log(line);
}

export async function activeRuns({ agentId }: RpcInput<typeof activeRunsRpc>): Promise<{ rows: DagRow[] }> {
  const origin = await resolveAgent(agentId);
  // No resolved OmO session means no runs can be attributed to this chat; other
  // chats in the same directory must not borrow each other's graphs.
  if (!origin.cwd || !origin.sessionId) return { rows: [] };
  const rows = (await readRows(origin.cwd, origin.sessionId, Date.now() - WINDOW_MS)).slice(-MAX_ROWS);
  announceOnce(agentId, `[omo-dag-chat] pill query agent=${agentId} cwd=${origin.cwd} rows=${rows.length}`);
  return { rows };
}
