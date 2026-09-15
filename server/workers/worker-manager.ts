import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PaseoApi, PaseoTerminal, PaseoTerminalActions, PaseoTerminalCreateOptions } from "@getpaseo/client";
import { findDependentWorkerIds, findReadyWorkers, validateBatch } from "./dag.js";
import { WorkerLifecycleWatcher, type WorkerStatusPayload } from "./worker-lifecycle.js";
import { WorkerStore } from "./worker-store.js";
import { WorkerError, type WorkerCancelInput, type WorkerCancelPayload, type WorkerGetInput,
  type WorkerGetPayload, type WorkerLaunchInput, type WorkerLaunchPayload,
  type WorkerListInput, type WorkerListPayload, type WorkerRecord } from "../../shared/workers.js";
import { createWorkerWorktree, ensureGitRepository, resolveWorktreePath, sanitizeBranchName } from "./worktree.js";
import { resolveOmoLaunch } from "../provider/omo-cli.js";

export type TerminalSnapshot = PaseoTerminal;
export type TerminalCreateOptions = PaseoTerminalCreateOptions;
export type PaseoTerminalsApi = PaseoTerminalActions;
export interface WorkerManagerOptions {
  readonly paseo: Pick<PaseoApi, "terminals">;
  readonly runtimeConfig?: {
    readonly bunPath?: string;
    readonly cliPath?: string;
    readonly stateDir?: string;
  };
  readonly store?: WorkerStore;
  readonly lifecycle?: WorkerLifecycleWatcher;
}

const finished = (worker: WorkerRecord) =>
  worker.status === "completed" || worker.status === "failed" || worker.status === "cancelled";

export class WorkerManager {
  private readonly store: WorkerStore;
  private readonly lifecycle: WorkerLifecycleWatcher;
  private readonly unsubscribers = new Map<string, () => void>();
  private queue: Promise<void> = Promise.resolve();
  private eventError: Error | undefined;
  private disposed = false;

  constructor(private readonly options: WorkerManagerOptions) {
    this.store = options.store ?? new WorkerStore({ storageDir: options.runtimeConfig?.stateDir });
    this.lifecycle = options.lifecycle ?? new WorkerLifecycleWatcher({
      stateDir: options.runtimeConfig?.stateDir && path.join(options.runtimeConfig.stateDir, "lifecycle"),
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    // The caller owns rejection. The queue tail must allow the next independent request.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  public launch(input: WorkerLaunchInput): Promise<WorkerLaunchPayload> {
    return this.serial(async () => {
      if (this.disposed) throw new WorkerError("STOPPED", "Worker plugin has stopped");
      const { workspaceId, agentId } = input;
      const { repoRoot } = await ensureGitRepository(input.repoRoot);
      const existing = this.store.getWorkers(workspaceId, agentId);
      validateBatch(input.workers, existing);
      const records = input.workers.map(spec => {
        const sessionId = randomUUID();
        return {
          id: spec.id, agentId, workspaceId, sessionId, repoRoot,
          title: spec.title, prompt: spec.prompt,
          cwd: resolveWorktreePath(repoRoot, `${spec.id}-${sessionId}`),
          branch: sanitizeBranchName(spec.branch ?? `omo/${spec.id}-${sessionId}`),
          dependsOn: spec.dependsOn,
          status: "pending" as const,
          createdAt: new Date().toISOString(),
          ...(spec.model ? { model: spec.model } : {}),
        };
      });
      await this.store.saveWorkers(workspaceId, agentId, [...existing, ...records]);
      await this.startReady(workspaceId, agentId);
      return this.list({ workspaceId, agentId });
    });
  }

  private observe(worker: WorkerRecord): void {
    this.unsubscribers.get(worker.sessionId)?.();
    const unwatch = this.lifecycle.watch(
      worker.sessionId, this.lifecycle.getStatusFilePath(worker.sessionId),
      payload => {
        void this.serial(async () => {
          if (!this.disposed) await this.applyStatus(worker, payload);
        }).catch(error => {
          this.eventError = error instanceof Error ? error : new WorkerError("LIFECYCLE", String(error));
        });
      },
      error => { this.eventError = error; },
    );
    this.unsubscribers.set(worker.sessionId, unwatch);
  }

  private release(worker: WorkerRecord): void {
    this.unsubscribers.get(worker.sessionId)?.();
    this.unsubscribers.delete(worker.sessionId);
  }

  private async startReady(workspaceId: string, agentId: string): Promise<void> {
    const workers = this.store.getWorkers(workspaceId, agentId);
    for (const worker of workers) {
      if (worker.status !== "pending") continue;
      const failedDependency = workers.find(candidate =>
        worker.dependsOn.includes(candidate.id) &&
        (candidate.status === "failed" || candidate.status === "cancelled"));
      if (failedDependency) await this.fail(worker, `Prerequisite worker "${failedDependency.id}" failed`);
    }
    for (const worker of findReadyWorkers(this.store.getWorkers(workspaceId, agentId))) {
      await this.startWorker(worker);
    }
  }

  private async fail(worker: WorkerRecord, error: string): Promise<void> {
    this.release(worker);
    await this.store.updateWorker(worker.workspaceId, worker.agentId, worker.id, {
      status: "failed", error, completedAt: new Date().toISOString(),
    });
    await this.finishDependents(worker, "failed");
  }

  private async finishDependents(worker: WorkerRecord, status: "failed" | "cancelled"): Promise<void> {
    const all = this.store.getWorkers(worker.workspaceId, worker.agentId);
    for (const id of findDependentWorkerIds(worker.id, all)) {
      const dependent = all.find(candidate => candidate.id === id);
      if (dependent?.status !== "pending") continue;
      await this.store.updateWorker(worker.workspaceId, worker.agentId, id, {
        status, completedAt: new Date().toISOString(),
        error: `Prerequisite worker "${worker.id}" ${status}`,
      });
    }
  }

  private async startWorker(worker: WorkerRecord): Promise<void> {
    const current = this.store.getWorker(worker.workspaceId, worker.agentId, worker.id);
    if (current?.status !== "pending") return;
    await this.store.updateWorker(worker.workspaceId, worker.agentId, worker.id, { status: "preparing" });
    try {
      await createWorkerWorktree({ repoRoot: worker.repoRoot, targetPath: worker.cwd, branch: worker.branch });
      const { extensionPath } = this.lifecycle.createExtensionScript({
        workerId: worker.id, sessionId: worker.sessionId,
      });
      // Subscribe before starting the process: even a very short first turn is observed.
      this.observe(worker);
      const runtime = this.options.runtimeConfig;
      // Resolve omo the same way the provider does - PATH first, then a Bun
      // global install - so a worker launches wherever omo is actually
      // installed rather than only from a Bun global layout.
      const launch = resolveOmoLaunch();
      const command = runtime?.bunPath ?? process.env.PASEO_OMO_BUN_PATH ?? launch.command;
      const cliOverride = runtime?.cliPath ?? process.env.PASEO_OMO_CLI_PATH;
      const base = cliOverride ? [cliOverride] : launch.base;
      // OmO treats @... as a file even after "--"; keep task text literal.
      const literalPrompt = worker.prompt.startsWith("@") ? `\n${worker.prompt}` : worker.prompt;
      const args = [...base, "--approve", "--session-id", worker.sessionId, "--name", worker.title,
        "--extension", extensionPath, ...(worker.model ? ["--model", worker.model] : []), "--", literalPrompt];
      const terminal = await this.options.paseo.terminals.create({
        workspaceId: worker.workspaceId, cwd: worker.cwd,
        name: `OmO: ${worker.title} [${worker.sessionId}]`, command, args,
      });
      await this.store.updateWorker(worker.workspaceId, worker.agentId, worker.id, {
        terminalId: terminal.id, status: "running", startedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await this.fail(worker, error.message);
    }
  }

  private async applyStatus(worker: WorkerRecord, payload: WorkerStatusPayload): Promise<void> {
    const current = this.store.getWorker(worker.workspaceId, worker.agentId, worker.id);
    if (!current || finished(current) || payload.sessionId !== current.sessionId ||
        payload.workerId !== current.id) return;
    switch (payload.status) {
      case "completed":
      case "failed":
      case "cancelled": {
        this.release(current);
        await this.store.updateWorker(current.workspaceId, current.agentId, current.id, {
          status: payload.status, completedAt: payload.timestamp,
          ...(payload.error ? { error: payload.error } : {}),
          ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
        });
        if (payload.status !== "completed") await this.finishDependents(current, payload.status);
        await this.startReady(current.workspaceId, current.agentId);
        break;
      }
      case "running":
      case "preparing":
      case "pending":
        break;
      default: {
        const unreachable: never = payload.status;
        throw new WorkerError("INVALID_STATUS", String(unreachable));
      }
    }
  }

  public list(input: WorkerListInput): WorkerListPayload {
    if (this.eventError) throw this.eventError;
    return { workers: this.store.getWorkers(input.workspaceId, input.agentId) };
  }

  public get(input: WorkerGetInput): WorkerGetPayload {
    return { worker: this.store.getWorker(input.workspaceId, input.agentId, input.workerId) ?? null };
  }

  public cancel(input: WorkerCancelInput): Promise<WorkerCancelPayload> {
    return this.serial(async () => {
      const worker = this.store.getWorker(input.workspaceId, input.agentId, input.workerId);
      if (!worker) throw new WorkerError("WORKER_NOT_FOUND", `Worker with ID "${input.workerId}" not found`);
      if (finished(worker)) return { worker };
      if (worker.terminalId) await this.options.paseo.terminals.ref(worker.terminalId).kill();
      this.release(worker);
      const cancelled = await this.store.updateWorker(input.workspaceId, input.agentId, input.workerId, {
        status: "cancelled", completedAt: new Date().toISOString(),
      });
      await this.finishDependents(worker, "cancelled");
      return { worker: cancelled };
    });
  }

  public recoverOnReload(workspaceId?: string): Promise<void> {
    return this.serial(async () => {
      const live = await this.options.paseo.terminals.list(workspaceId ? { workspaceId } : {});
      for (const group of this.store.getAllGroups()) {
        if (workspaceId && group.workspaceId !== workspaceId) continue;
        for (const worker of group.workers) {
          if (finished(worker) || worker.status === "pending") continue;
          const status = this.lifecycle.readStatus(this.lifecycle.getStatusFilePath(worker.sessionId));
          if (status && ["completed", "failed", "cancelled"].includes(status.status)) {
            await this.applyStatus(worker, status);
            continue;
          }
          const terminal = live.entries.find(candidate =>
            candidate.workspaceId === worker.workspaceId &&
            (candidate.id === worker.terminalId || candidate.name === `OmO: ${worker.title} [${worker.sessionId}]`));
          if (!terminal) {
            await this.fail(worker, "Worker terminal was lost before a completion signal");
            continue;
          }
          if (worker.terminalId !== terminal.id || worker.status !== "running") {
            await this.store.updateWorker(worker.workspaceId, worker.agentId, worker.id, {
              terminalId: terminal.id, status: "running",
            });
          }
          if (!this.unsubscribers.has(worker.sessionId)) this.observe(worker);
        }
        await this.startReady(group.workspaceId, group.agentId);
      }
    });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.lifecycle.clear();
  }
}
