import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

import { DagPillPopover } from "./pill.js";
import { activeRunsRpc, type DagRow } from "../shared/row.js";

/**
 * How long to wait after an agent update before refreshing. Agent updates
 * arrive in bursts while a turn streams; coalescing them keeps one RPC per
 * burst instead of one per event. This is a debounce, not a poll: with no
 * updates, no work happens at all.
 */
const COALESCE_MS = 250;

/**
 * `agents.subscribe` is the agent-update stream, and a DAG run advances on the
 * daemon's disk without producing one — a background worker finishing under an
 * idle agent would otherwise leave a stale count on screen. So while a run is
 * live the pill re-checks on this bounded interval, and when nothing is running
 * no timer is armed at all.
 */
const BACKSTOP_MS = 3_000;

type ListedAgent = {
  id: string;
  provider?: string | null;
  workspaceId?: string | null;
};

/**
 * `agents.list()` is a protocol payload whose entry shape varies by daemon
 * version: an array, `{ entries }`, or `{ agents }`, each item being the agent
 * or a wrapper around it. Normalize once, here at the boundary.
 */
export function listedAgents(payload: unknown): ListedAgent[] {
  const record = (payload ?? {}) as { entries?: readonly unknown[]; agents?: readonly unknown[] };
  const items: readonly unknown[] = Array.isArray(payload) ? payload : (record.entries ?? record.agents ?? []);
  const agents: ListedAgent[] = [];
  for (const item of items) {
    const candidate = (item as { agent?: unknown })?.agent ?? item;
    const agent = candidate as ListedAgent | null;
    if (!agent || typeof agent.id !== "string") continue;
    agents.push({
      id: agent.id,
      ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
      ...(agent.workspaceId !== undefined ? { workspaceId: agent.workspaceId } : {}),
    });
  }
  return agents;
}

export function pillLabel(rows: readonly DagRow[]): string | null {
  const live = rows.find((row) => row.status === "running") ?? rows[rows.length - 1];
  if (!live) return null;
  return `DAG ${live.completed}/${live.total}`;
}

export const isOmoAgent = (agent: ListedAgent): boolean =>
  (agent.provider ?? "").toLowerCase().includes("omo");

/**
 * Per-agent composer pill showing that agent's live DAG progress.
 *
 * Driven by `agents.subscribe`, so the pill reacts to agent updates instead of
 * re-listing every few seconds. The previous implementation polled on a fixed
 * 3s interval whether or not anything had changed.
 */
export function contributeDagPill(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  /** Liveness of the last refresh that completed, so a failed one can keep it. */
  let lastLive = false;

  function clearBackstop(): void {
    if (backstop === null) return;
    clearTimeout(backstop);
    backstop = null;
  }

  function armBackstop(): void {
    if (disposed || backstop !== null) return;
    backstop = setTimeout(() => {
      backstop = null;
      void sync();
    }, BACKSTOP_MS);
  }

  const sync = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    // A refresh that throws keeps the previous answer: the backend reports a
    // broken run store as a failure rather than an empty list, and treating
    // that as "nothing is running" would retire the backstop and freeze the
    // pill until the next agent update.
    let live = lastLive;
    try {
      const agents = listedAgents(await client.paseo.agents.list());
      if (disposed) return;
      const seen = new Set<string>();
      let anyLive = false;

      for (const agent of agents) {
        const { workspaceId } = agent;
        if (!workspaceId || !isOmoAgent(agent)) continue;
        seen.add(agent.id);

        let pill = pills.get(agent.id);
        if (!pill) {
          pill = client.addComposerPill({
            id: "dag",
            workspaceId,
            agentId: agent.id,
            button: {
              title: "OmO DAG",
              icon: "GitFork",
              label: "DAG",
              visible: false,
              behavior: { kind: "popover", Content: DagPillPopover },
            },
          });
          pills.set(agent.id, pill);
        }

        const { rows } = await client.rpc(activeRunsRpc, { agentId: agent.id });
        if (disposed) return;
        if (rows.some((candidate) => candidate.status === "running")) anyLive = true;
        const label = pillLabel(rows);
        pill.update(label === null ? { visible: false } : { label, visible: true });
      }

      for (const [agentId, pill] of pills) {
        if (seen.has(agentId)) continue;
        pill.remove();
        pills.delete(agentId);
      }
      live = anyLive;
    } catch (error) {
      console.error("[omo-dag] pill refresh failed", error);
    } finally {
      running = false;
      lastLive = live;
      if (live && !disposed) armBackstop();
      else clearBackstop();
      if (again && !disposed) {
        again = false;
        schedule();
      }
    }
  };

  function schedule(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, COALESCE_MS);
  }

  const unsubscribe = client.paseo.agents.subscribe(() => {
    schedule();
  });

  void sync();

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    clearBackstop();
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
