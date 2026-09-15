import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { WorkerManager } from "./worker-manager.js";
import {
  cancelWorkerRpc,
  getWorkerRpc,
  launchWorkersRpc,
  listWorkersRpc,
  WorkerError,
  type WorkerCancelInput,
  type WorkerCancelPayload,
  type WorkerGetInput,
  type WorkerGetPayload,
  type WorkerLaunchInput,
  type WorkerLaunchPayload,
  type WorkerListInput,
  type WorkerListPayload,
} from "../../shared/workers.js";

let defaultWorkerManager: WorkerManager | null = null;
let recovery: Promise<void> | undefined;

export function getWorkerManager(
  context?: PluginHandlerContext,
): WorkerManager {
  if (!defaultWorkerManager && context) {
    defaultWorkerManager = new WorkerManager({ paseo: context.paseo });
    recovery = defaultWorkerManager.recoverOnReload();
  }
  if (!defaultWorkerManager) {
    throw new WorkerError("NOT_INITIALIZED", "WorkerManager requires a plugin handler context");
  }

  return defaultWorkerManager;
}

export function setWorkerManager(manager: WorkerManager | null): void {
  defaultWorkerManager = manager;
  recovery = undefined;
}

export async function launchWorkers(
  input: WorkerLaunchInput,
  context: PluginHandlerContext,
): Promise<WorkerLaunchPayload> {
  const manager = getWorkerManager(context);
  await recovery;
  return manager.launch(input);
}

export async function listWorkers(
  input: WorkerListInput,
  context: PluginHandlerContext,
): Promise<WorkerListPayload> {
  const manager = getWorkerManager(context);
  await recovery;
  await manager.recoverOnReload(input.workspaceId);
  return manager.list(input);
}

export async function cancelWorker(
  input: WorkerCancelInput,
  context: PluginHandlerContext,
): Promise<WorkerCancelPayload> {
  const manager = getWorkerManager(context);
  await recovery;
  return manager.cancel(input);
}

export async function getWorker(
  input: WorkerGetInput,
  context: PluginHandlerContext,
): Promise<WorkerGetPayload> {
  const manager = getWorkerManager(context);
  await recovery;
  return manager.get(input);
}

export function registerWorkerHandlers(
  plugin: Pick<PluginServerContext, "handle">,
  customManager?: WorkerManager,
): PluginCleanup {
  if (customManager) {
    setWorkerManager(customManager);
  }

  plugin.handle(launchWorkersRpc, launchWorkers);
  plugin.handle(listWorkersRpc, listWorkers);
  plugin.handle(cancelWorkerRpc, cancelWorker);
  plugin.handle(getWorkerRpc, getWorker);

  return async () => {
    if (defaultWorkerManager) {
      await defaultWorkerManager.dispose();
      defaultWorkerManager = null;
    }
  };
}
