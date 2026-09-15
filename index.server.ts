import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import { activeRuns } from "./server/chat/active.js";
import { agentDagSnapshot, createPublisher } from "./server/chat/publisher.js";
import { getSnapshot, listSessions } from "./server/dag/dag.js";
import { listProjects } from "./server/dag/projects.js";
import { registerApprovalHandlers } from "./server/provider/approval.js";
import { createOmoProvider } from "./server/provider/provider.js";
import { registerUpdateHandlers } from "./server/provider/update.js";
import { registerWorkerHandlers } from "./server/workers/workers.js";
import { getSnapshotRpc, listProjectsRpc, listSessionsRpc } from "./shared/dag.js";
import { activeRunsRpc, agentDagSnapshotRpc } from "./shared/row.js";

/**
 * Paseo 0.8.0 closes a provider connection while it is also tearing this
 * subprocess's IPC channel down, so its own reply can hit a closed channel and
 * raise an unhandled `error` event on `process`, which kills the subprocess mid
 * teardown and leaves OmO children without a clean stdin EOF. Observing the
 * event keeps shutdown graceful; anything that is not the channel race is still
 * reported on stderr.
 */
function observeIpcTeardown(): () => void {
  const onError = (error: unknown): void => {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ERR_IPC_CHANNEL_CLOSED" || code === "EPIPE") return;
    console.error("[omo] process error", error);
  };
  process.on("error", onError);
  return () => process.off("error", onError);
}

/**
 * Single daemon entry for every OmO backend contribution: the agent provider,
 * the DAG snapshot RPCs, the worker RPCs, and the timeline publisher that feeds
 * the composer pill.
 *
 * The publisher is constructed exactly once here. Identity of a published row is
 * the daemon's: it keeps only the latest value for a given plugin and item id,
 * so re-appending `dag-<runId>` replaces that card instead of adding one, and
 * that holds across a plugin reload where an in-process map cannot. The per-run
 * signature map is a write-reduction cache on top of that, and a second
 * publisher instance would only double the redundant appends and the polling.
 */
export default function contribute(server: PluginServerContext): PluginCleanup {
  const releaseIpcObserver = observeIpcTeardown();
  const publisher = createPublisher();

  server.registerProvider(createOmoProvider());

  server.handle(listSessionsRpc, listSessions);
  server.handle(getSnapshotRpc, getSnapshot);
  server.handle(activeRunsRpc, activeRuns);
  // The agent-side DAG panel asks for its own session's snapshot by agent id,
  // which is what keeps it from listing every session in the project.
  server.handle(agentDagSnapshotRpc, agentDagSnapshot);
  server.handle(listProjectsRpc, listProjects);

  // The approval RPCs reach the live OmoSession through a registry each session
  // joins on construction, which is why they are registered here next to the
  // provider rather than inside it.
  const releaseApprovals = registerApprovalHandlers(server);

  // Update lives next to the provider for the same reason: suspending and
  // resuming sessions reaches the live OmoSession objects through the registry
  // they join on construction.
  const releaseUpdate = registerUpdateHandlers(server);

  // The worker RPCs come with the only disposal path for the lazily created
  // WorkerManager, so the entry registers them through their own owner and
  // releases that handle below instead of wiring the four handlers by hand.
  const releaseWorkers = registerWorkerHandlers(server);

  const offTurnStarted = server.on("agent.turn_started", (event, context) =>
    publisher.onTurnStarted(event.agent, context),
  );
  const offTurnEnded = server.on("agent.turn_ended", (event, context) =>
    publisher.onTurnEnded(event.agent, context),
  );

  return async () => {
    offTurnStarted();
    offTurnEnded();
    releaseApprovals();
    releaseUpdate();
    publisher.dispose();
    await releaseWorkers();
    releaseIpcObserver();
  };
}
