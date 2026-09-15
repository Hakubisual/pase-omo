import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "../index.server.js";
import { createOmoProvider } from "../server/provider/provider.js";
import type { WorkerManager } from "../server/workers/worker-manager.js";
import { getWorkerManager, setWorkerManager } from "../server/workers/workers.js";
import { duplicates, recordingServer } from "./recording.js";

afterEach(() => {
  setWorkerManager(null);
});

/**
 * C2 - every RPC the four originals served must be served once by the merged
 * server entry, and the OmO provider must be registered exactly once.
 */
describe("unified server registrations", () => {
  it("handles the union of all four plugins' RPCs, each once", () => {
    const { ctx, rec } = recordingServer();
    contribute(ctx as never);

    expect([...rec.handlers].sort()).toEqual([
      // The approval pair lets the plugin's own popup read and answer a pending
      // OmO confirm/select/question instead of leaving it to the host prompt.
      "approval.pending",
      "approval.respond",
      "dag.active",
      // The agent-side panel resolves its own session's snapshot through this
      // one; without it registered the panel beside an agent stays empty.
      "dag.agent-snapshot",
      "dag.projects",
      "dag.sessions",
      "dag.snapshot",
      "workers.cancel",
      "workers.get",
      "workers.launch",
      "workers.list",
    ]);
    expect(duplicates(rec.handlers)).toEqual([]);
  });

  it("registers the OmO provider exactly once", () => {
    const { ctx, rec } = recordingServer();
    contribute(ctx as never);
    expect(rec.providers).toBe(1);
  });

  it("ships the provider icon asset it registers", () => {
    // Regression: the daemon refuses to load the plugin with
    // `Invalid plugin provider icon "icon.svg"` when the asset is not shipped.
    const icon = createOmoProvider().icon;
    expect(icon).toBeTruthy();
    const assetPath = fileURLToPath(new URL(`../${icon}`, import.meta.url));
    expect(existsSync(assetPath)).toBe(true);
    expect(statSync(assetPath).isFile()).toBe(true);
  });

  it("subscribes to the agent turn lifecycle the composer pill depends on", () => {
    const { ctx, rec } = recordingServer();
    contribute(ctx as never);
    expect([...rec.events].sort()).toEqual(["agent.turn_ended", "agent.turn_started"]);
  });

  it("disposes the worker manager on cleanup", async () => {
    // The four worker RPCs are the only owners of the lazily created
    // WorkerManager; if the merged entry drops its disposal the manager keeps
    // its terminal watchers alive across a plugin reload.
    let disposals = 0;
    setWorkerManager({ dispose: async () => { disposals += 1; } } as unknown as WorkerManager);

    const { ctx } = recordingServer();
    const cleanup = contribute(ctx as never);
    await cleanup();

    expect(disposals).toBe(1);
    expect(() => getWorkerManager()).toThrow();
  });

  it("releases its lifecycle subscriptions on cleanup", () => {
    const { ctx, rec } = recordingServer();
    const cleanup = contribute(ctx as never);
    expect(rec.outstanding.size).toBe(rec.events.length);
    cleanup();
    // Identity, not a count, for the same reason as the client entry.
    expect([...rec.outstanding]).toEqual([]);
  });
});
