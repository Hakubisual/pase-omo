import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "vitest";
import { WorkerLifecycleWatcher } from "./worker-lifecycle.js";

test("preserves worker lifecycle files when the plugin stops for reload", () => {
  // Given a running worker's extension and saved completion record.
  const stateDir = mkdtempSync(join(tmpdir(), "omo-lifecycle-"));
  const lifecycle = new WorkerLifecycleWatcher({ stateDir });
  try {
    const files = lifecycle.createExtensionScript({
      workerId: "worker",
      sessionId: "a10316a8-58f8-4a6f-b7dc-445ed766dc58",
    });
    lifecycle.emitStatusUpdate(files.statusFilePath, {
      workerId: "worker",
      sessionId: "a10316a8-58f8-4a6f-b7dc-445ed766dc58",
      status: "completed",
      timestamp: new Date().toISOString(),
    });

    // When the plugin releases its subscriptions.
    lifecycle.clear();

    // Then the independent worker and the next plugin process retain their files.
    expect(existsSync(files.extensionPath)).toBe(true);
    expect(existsSync(files.statusFilePath)).toBe(true);
  } finally {
    lifecycle.clear();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reports provider failure from real agent_end messages after the run settles", async () => {
  // Given the real generated extension and the actual Senpi event shape.
  const stateDir = mkdtempSync(join(tmpdir(), "omo-lifecycle-events-"));
  const lifecycle = new WorkerLifecycleWatcher({ stateDir });
  try {
    const files = lifecycle.createExtensionScript({
      workerId: "worker",
      sessionId: "d05f6c33-b18b-49f0-89a6-ebd9f9befbfe",
    });
    const loaded: unknown = await import(pathToFileURL(files.extensionPath).href);
    if (!loaded || typeof loaded !== "object" || !("default" in loaded) ||
        typeof loaded.default !== "function") throw new Error("Missing lifecycle extension");
    const hooks = new Map<string, (event: unknown) => Promise<void>>();
    loaded.default({
      on(name: string, handler: (event: unknown) => Promise<void>) {
        hooks.set(name, handler);
      },
    });

    // When an assistant error ends and settles the run.
    await hooks.get("agent_end")?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
    });
    await hooks.get("agent_settled")?.({ type: "agent_settled" });

    // Then failure is recorded rather than inferred success from a missing event.error.
    expect(lifecycle.readStatus(files.statusFilePath)).toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });
  } finally {
    lifecycle.clear();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
