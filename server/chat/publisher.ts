import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import {
  agentDagSnapshotRpc,
  DAG_ROW_KIND,
  DAG_ROW_VERSION,
  currentRow,
  isSettledRun,
  type AgentDagSnapshotPayload,
  type DagRow,
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
  /** Newest row seen by a tick, drawn if the watch retires before it settles. */
  latest: DagRow | null;
  /** The tick currently reading the run store, so a caller can wait it out. */
  inFlight: Promise<void> | null;
  /** The agent this watch follows, so a flush can read without a hook event. */
  agent: PluginHookAgent;
  /**
   * False until the first read. Runs that had already settled before this watch
   * existed are history: they are recorded as drawn without being drawn, so a
   * new turn does not open with a screen of cards for work the user already saw.
   */
  primed: boolean;
};

export type Publisher = {
  onTurnStarted(agent: PluginHookAgent, context: PluginHookContext): Promise<void>;
  onTurnEnded(agent: PluginHookAgent, context: PluginHookContext): Promise<void>;
  /**
   * Reads the run store now for every live watch and waits for the result.
   *
   * A tick is started by a timer but finishes on disk I/O, so advancing a clock
   * says nothing about whether the card for that moment has been drawn. A caller
   * that needs the store's current state reflected - a test, or a shutdown that
   * wants the last card out - asks here instead of guessing a delay.
   */
  settle(): Promise<void>;
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
   * Runs already drawn, for the publisher's lifetime. Timeline append is
   * append-only - there is no update - so a run drawn twice is two cards in the
   * conversation, and a ten-node run redrawn on every state change walks the
   * live card off the top of a phone screen. Session id is part of the key so a
   * reused agent/run id cannot suppress a different run.
   */
  const published = new Set<string>();
  let disposed = false;

  const watchOf = (agent: PluginHookAgent, context: PluginHookContext): Watch => {
    const existing = watches.get(agent.id);
    if (existing) {
      existing.context = context;
      existing.agent = agent;
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
      latest: null,
      inFlight: null,
      agent,
      primed: false,
    };
    watches.set(agent.id, created);
    return created;
  };

  const tick = async (agent: PluginHookAgent, context: PluginHookContext): Promise<void> => {
    if (disposed) return;
    const watch = watchOf(agent, context);
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
      // Teardown happens while this is awaiting: the host can dispose the
      // publisher, and the grace window can retire this watch. Either way these
      // rows belong to whatever comes next, not to this tick.
      if (disposed || watch.ended) return;
      // The run being worked on right now is the one the chat follows; it is
      // also the one drawn if this watch retires before it settles.
      const current = currentRow(rows);
      if (current !== undefined) watch.latest = current;

      for (const row of rows) {
        if (!isSettledRun(row.status)) continue;
        // A run in motion belongs to the composer pill, which re-renders in
        // place. The chat gets the card once, in the state the run settled in.
        if (watch.primed || row.runId === current?.runId) {
          await publish(agent.id, watch, row);
          if (disposed || watch.ended) return;
          continue;
        }
        suppress(agent.id, watch, row);
      }
      watch.primed = true;
      watch.failed = false;
    } catch (error) {
      // Report the first failure of a streak only: the poller retries every tick.
      if (!watch.failed) console.error("[omo-dag-chat] publish failed", error);
      watch.failed = true;
    } finally {
      watch.ticking = false;
    }
  };

  const publicationKey = (agentId: string, watch: Watch, row: DagRow): string =>
    JSON.stringify([agentId, watch.sessionId, row.runId]);

  /** Records a run as drawn without drawing it: history this chat did not watch. */
  const suppress = (agentId: string, watch: Watch, row: DagRow): void => {
    published.add(publicationKey(agentId, watch, row));
  };

  /** Draws a run's card, at most once per run for this publisher's lifetime. */
  const publish = async (agentId: string, watch: Watch, row: DagRow): Promise<void> => {
    const key = publicationKey(agentId, watch, row);
    if (published.has(key)) return;
    published.add(key);
    try {
      await watch.context.paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `dag-${row.runId}`,
        kind: DAG_ROW_KIND,
        version: DAG_ROW_VERSION,
        data: row,
      });
      console.log(`[omo-dag-chat] published ${row.runId} ${row.completed}/${row.total} ${row.status}`);
    } catch (error) {
      // Let the next tick try again rather than losing the card to one failed
      // append.
      published.delete(key);
      throw error;
    }
  };

  /**
   * Runs a tick and records it, so `settle()` has something to wait for.
   *
   * A timer that fires while the previous read is still on disk must not replace
   * the recorded promise: `tick` returns at once in that case, and storing that
   * immediate promise would report the watch as idle while a read is still
   * running - which is how a card could be drawn after the caller believed the
   * publisher had caught up.
   */
  const track = (agent: PluginHookAgent, watch: Watch): void => {
    if (watch.inFlight !== null) return;
    const running = tick(agent, watch.context).finally(() => {
      if (watch.inFlight === running) watch.inFlight = null;
    });
    watch.inFlight = running;
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
  const endWatch = async (agentId: string, watch: Watch): Promise<void> => {
    stopTimer(watch);
    // The last word on a run nobody is watching any more: a run still working
    // when its watch retires is drawn as it stands, so the conversation is not
    // left with no record of it at all.
    const row = watch.latest;
    watch.ended = true;
    watches.delete(agentId);
    if (row === null || disposed) return;
    try {
      await publish(agentId, watch, row);
    } catch (error) {
      console.error("[omo-dag-chat] publish failed", error);
    }
  };

  return {
    async onTurnStarted(agent, context) {
      if (disposed) return;
      console.log(`[omo-dag-chat] turn_started ${agent.id} provider=${agent.provider}`);
      if (!agent.provider.toLowerCase().includes("omo")) return;
      const watch = watchOf(agent, context);
      if (watch.grace !== null) {
        clearTimeout(watch.grace);
        watch.grace = null;
      }
      if (watch.timer === null) {
        watch.timer = setInterval(() => {
          track(agent, watch);
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
      const watch = watchOf(agent, context);
      if (watch.timer === null) {
        watch.timer = setInterval(() => {
          track(agent, watch);
        }, POLL_INTERVAL_MS);
        watch.timer.unref?.();
      }
      if (watch.grace === null) {
        // Keep the card live for a short window while the user is still looking at it.
        watch.grace = setTimeout(() => {
          watch.grace = null;
          void endWatch(agent.id, watch);
        }, GRACE_MS);
        watch.grace.unref?.();
      }
    },
    async settle() {
      for (const watch of [...watches.values()]) {
        // Whatever a timer already started finishes first, then one read of the
        // store as it stands right now.
        if (watch.inFlight !== null) await watch.inFlight;
        await tick(watch.agent, watch.context);
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
