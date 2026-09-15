import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import {
  agentDagSnapshotRpc,
  DAG_ROW_KIND,
  DAG_ROW_VERSION,
  currentRow,
  rowSignature,
  type AgentDagSnapshotPayload,
} from "../../shared/row";
import { getDagSnapshot } from "../dag/dag-store.js";
import { readRows, resolveAgent, resolveSessionId } from "./runs";

/** Disk polling cadence while a turn is running. */
const POLL_INTERVAL_MS = 1500;
/** Runs older than this when a turn starts are treated as history and stay out of the chat. */
const LOOKBACK_MS = 20 * 60 * 1000;
/** Polling continues this long after a turn ends, so a live run keeps updating its card. */
const GRACE_MS = 90 * 1000;

type Watch = {
  timer: ReturnType<typeof setInterval> | null;
  grace: ReturnType<typeof setTimeout> | null;
  /** Freshest hook context; every lifecycle event refreshes it. */
  context: PluginHookContext;
  sessionId: string | null;
  /** Whether the "still unresolved" line was already written for this watch. */
  announced: boolean;
  since: number;
  ticking: boolean;
  failed: boolean;
  /** Set when the grace window closed; a tick still in flight stops here. */
  ended: boolean;
};

export type Publisher = {
  onTurnStarted(agent: PluginHookAgent, context: PluginHookContext): Promise<void>;
  onTurnEnded(agent: PluginHookAgent, context: PluginHookContext): Promise<void>;
  dispose(): void;
};

/** Resolves the current agent's full DAG snapshot entirely on the daemon. */
export async function agentDagSnapshot(
  { agentId }: RpcInput<typeof agentDagSnapshotRpc>,
): Promise<AgentDagSnapshotPayload> {
  const origin = await resolveAgent(agentId);
  if (!origin.cwd || !origin.sessionId) return { sessionId: null, runs: [], tasks: [] };
  return getDagSnapshot({ cwd: origin.cwd, sessionId: origin.sessionId });
}

export function createPublisher(): Publisher {
  const watches = new Map<string, Watch>();
  /**
   * Timeline append is append-only, so forgetting a published signature when a
   * turn watch retires creates another rendered card for the same logical run.
   * Keep this small identity cache for the publisher lifetime; session id is
   * part of the key so a reused agent/run id cannot suppress a different run.
   */
  const published = new Map<string, string>();
  let disposed = false;

  const watchOf = (agentId: string, context: PluginHookContext): Watch => {
    const existing = watches.get(agentId);
    if (existing) {
      existing.context = context;
      return existing;
    }
    const created: Watch = {
      timer: null,
      grace: null,
      context,
      sessionId: null,
      announced: false,
      since: Date.now() - LOOKBACK_MS,
      ticking: false,
      failed: false,
      ended: false,
    };
    watches.set(agentId, created);
    return created;
  };

  const tick = async (agent: PluginHookAgent, context: PluginHookContext): Promise<void> => {
    if (disposed) return;
    const watch = watchOf(agent.id, context);
    if (watch.ticking) return;
    watch.ticking = true;
    try {
      if (watch.sessionId === null) {
        // The daemon writes an agent's runtime session record after the agent
        // exists, so the first lookup of a fresh chat can legitimately miss.
        // Latching that miss would disable publishing for that agent's whole
        // lifetime, so the lookup is retried until it answers; only the log
        // line is suppressed after the first miss.
        watch.sessionId = await resolveSessionId(agent.id);
        if (watch.sessionId !== null || !watch.announced) {
          watch.announced = true;
          console.log(`[omo-dag-chat] agent ${agent.id} cwd=${agent.cwd} session=${watch.sessionId ?? "unresolved"}`);
        }
      }
      // Without a resolved session the runs on disk cannot be attributed to this
      // chat, so nothing is published rather than publishing a neighbour's graph.
      if (watch.sessionId === null) return;
      const rows = await readRows(agent.cwd, watch.sessionId, watch.since);
      const timeline = watch.context.paseo.agents.ref(agent.id).timeline;
      // One graph in the chat: the run being worked on right now. Publishing a
      // card per run buried the live one under finished ones.
      const row = currentRow(rows);
      if (row !== undefined) {
        // Teardown happens while this is awaiting: the host can dispose the
        // publisher, and the grace window can retire this watch. Either way the
        // row belongs to whatever comes next, not to this tick.
        if (disposed || watch.ended) return;
        const signature = rowSignature(row);
        const publicationKey = JSON.stringify([agent.id, watch.sessionId, row.runId]);
        if (published.get(publicationKey) !== signature) {
          await timeline.append({
            type: "plugin",
            id: `dag-${row.runId}`,
            kind: DAG_ROW_KIND,
            version: DAG_ROW_VERSION,
            data: row,
          });
          published.set(publicationKey, signature);
          console.log(`[omo-dag-chat] published ${row.runId} ${row.completed}/${row.total} ${row.status}`);
        }
      }
      watch.failed = false;
    } catch (error) {
      // Report the first failure of a streak only: the poller retries every tick.
      if (!watch.failed) console.error("[omo-dag-chat] publish failed", error);
      watch.failed = true;
    } finally {
      watch.ticking = false;
    }
  };

  const stopTimer = (watch: Watch): void => {
    if (watch.grace !== null) {
      clearTimeout(watch.grace);
      watch.grace = null;
    }
    if (watch.timer === null) return;
    clearInterval(watch.timer);
    watch.timer = null;
  };

  /**
   * Ends polling once the grace window closes. Published row signatures stay
   * alive separately because Paseo persists every append as another timeline
   * row even when the plugin item id is unchanged.
   */
  const endWatch = (agentId: string, watch: Watch): void => {
    stopTimer(watch);
    watch.ended = true;
    watches.delete(agentId);
  };

  return {
    async onTurnStarted(agent, context) {
      if (disposed) return;
      console.log(`[omo-dag-chat] turn_started ${agent.id} provider=${agent.provider}`);
      if (!agent.provider.toLowerCase().includes("omo")) return;
      const watch = watchOf(agent.id, context);
      if (watch.grace !== null) {
        clearTimeout(watch.grace);
        watch.grace = null;
      }
      if (watch.timer === null) {
        watch.timer = setInterval(() => {
          void tick(agent, watch.context);
        }, POLL_INTERVAL_MS);
        watch.timer.unref?.();
      }
      await tick(agent, context);
    },
    async onTurnEnded(agent, context) {
      if (disposed) return;
      console.log(`[omo-dag-chat] turn_ended ${agent.id} provider=${agent.provider}`);
      if (!agent.provider.toLowerCase().includes("omo")) return;
      // A turn that ends without a prior start still publishes: the plugin may
      // have been installed mid-turn.
      await tick(agent, context);
      if (disposed) return;
      const watch = watchOf(agent.id, context);
      if (watch.timer === null) {
        watch.timer = setInterval(() => {
          void tick(agent, watch.context);
        }, POLL_INTERVAL_MS);
        watch.timer.unref?.();
      }
      if (watch.grace === null) {
        // Keep the card live for a short window while the user is still looking at it.
        watch.grace = setTimeout(() => {
          watch.grace = null;
          endWatch(agent.id, watch);
        }, GRACE_MS);
        watch.grace.unref?.();
      }
    },
    dispose() {
      disposed = true;
      for (const watch of watches.values()) stopTimer(watch);
      watches.clear();
      published.clear();
    },
  };
}
