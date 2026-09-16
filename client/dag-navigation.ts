import type { PluginClientContext } from "@getpaseo/plugin/client";

import { DAG_PANEL_ID } from "../shared/ids.js";
import { locateDagRpc, type DagDestination } from "../shared/navigate.js";
import { listedAgents } from "./dag-pill.js";

/**
 * Navigation from a conversation into the DAG dashboard.
 *
 * The host opens a panel by id and carries no payload with it, so the requested
 * destination is handed over here: the request resolves the owning session on
 * the daemon, parks it for the workspace it belongs to, and then asks the host
 * to open the panel. The panel picks the destination up on its next render and
 * applies it over whatever it had selected or remembered.
 */

let host: PluginClientContext | null = null;

export function setDagNavigationHost(client: PluginClientContext | null): void {
  host = client;
}

const pendingByCwd = new Map<string, DagDestination>();
const listeners = new Set<() => void>();

export function subscribeDagDestination(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekDagDestination(cwd: string): DagDestination | null {
  return pendingByCwd.get(cwd) ?? null;
}

/** Applied destinations are dropped, so a later refresh cannot re-apply them. */
export function consumeDagDestination(cwd: string): void {
  if (pendingByCwd.delete(cwd)) notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

export interface DagNavigationRequest {
  agentId?: string;
  cwd?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  workspaceId?: string;
}

export type DagNavigationResult = { ok: true; reason?: string } | { ok: false; reason: string };

async function workspaceIdFor(client: PluginClientContext, agentId: string): Promise<string | null> {
  const agents = listedAgents(await client.paseo.agents.list());
  return agents.find((agent) => agent.id === agentId)?.workspaceId ?? null;
}

/**
 * Open the dashboard on the work this card belongs to.
 *
 * Nothing is started, resumed or cancelled: this reads the ownership records and
 * opens a panel. A destination that cannot be resolved returns its reason for
 * the caller to show instead of opening an unrelated session.
 */
export async function openInDagDashboard(
  request: DagNavigationRequest,
): Promise<DagNavigationResult> {
  const client = host;
  if (!client) {
    return { ok: false, reason: "The OmO DAG panel is not available in this window." };
  }

  const { destination, reason } = await client.rpc(locateDagRpc, {
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
  });
  if (!destination) {
    return { ok: false, reason: reason ?? "That DAG destination no longer exists." };
  }

  pendingByCwd.set(destination.cwd, destination);
  notify();

  const workspaceId =
    request.workspaceId ??
    (request.agentId === undefined ? null : await workspaceIdFor(client, request.agentId));
  if (!workspaceId) {
    // The destination is parked, so opening the panel by hand still lands on it.
    return { ok: false, reason: "Could not tell which workspace to open; open the OmO DAG panel." };
  }

  client.openPanel(DAG_PANEL_ID, { workspaceId, location: "explorer" });
  return { ok: true, ...(reason === undefined ? {} : { reason }) };
}

/**
 * What the panel should select for a destination, given the sessions it lists.
 *
 * An explicit destination outranks the remembered selection, and a destination
 * whose session is not listed says so rather than silently opening another one.
 */
export function destinationSelection(
  destination: DagDestination,
  sessions: readonly { id: string }[],
): { sessionId: string; listed: boolean } {
  return {
    sessionId: destination.sessionId,
    listed: sessions.some((session) => session.id === destination.sessionId),
  };
}
