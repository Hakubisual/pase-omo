import { WorkerError, type WorkerItemSpec, type WorkerRecord } from "../../shared/workers.js";

export function validateBatch(
  newWorkers: WorkerItemSpec[],
  existingWorkers: WorkerRecord[] = [],
): void {
  // 1. Check duplicate IDs within the incoming batch
  const seenBatchIds = new Set<string>();
  for (const w of newWorkers) {
    if (!w.id.trim() || w.id.trim() !== w.id) {
      throw new WorkerError("INVALID_ID", "Worker ID must be nonempty with no surrounding whitespace");
    }
    const id = w.id.trim();
    if (seenBatchIds.has(id)) {
      throw new WorkerError("DUPLICATE_ID", `Duplicate worker ID in batch: "${id}"`);
    }
    seenBatchIds.add(id);
  }

  // A historical ID still identifies its worktree and dependency results.
  const activeExisting = new Set(existingWorkers.map((w) => w.id));
  for (const w of newWorkers) {
    if (activeExisting.has(w.id)) {
      throw new WorkerError("DUPLICATE_ID", `Worker with ID "${w.id}" is already active or recorded`);
    }
  }

  // 3. Check for unknown dependencies and self-dependencies
  const allKnownIds = new Set([
    ...newWorkers.map((w) => w.id),
    ...existingWorkers.map((w) => w.id),
  ]);

  for (const w of newWorkers) {
    const deps = w.dependsOn || [];
    for (const depId of deps) {
      if (!allKnownIds.has(depId)) {
        throw new WorkerError("MISSING_DEPENDENCY", `Unknown dependency: worker "${w.id}" depends on unknown worker "${depId}"`);
      }
      if (depId === w.id) {
        throw new WorkerError("CYCLE_DETECTED", `Cycle detected in worker dependencies: worker "${w.id}" depends on itself`);
      }
    }
  }

  // 4. Cycle detection using Depth-First Search with 3-color marking
  // Build graph: child -> dependencies
  const graph = new Map<string, string[]>();

  // Add existing workers to graph
  for (const w of existingWorkers) {
    graph.set(w.id, [...(w.dependsOn || [])]);
  }
  // Add new workers to graph
  for (const w of newWorkers) {
    graph.set(w.id, [...(w.dependsOn || [])]);
  }

  // 0 = unvisited, 1 = visiting (in current DFS stack), 2 = visited
  const visitState = new Map<string, 0 | 1 | 2>();

  function dfs(nodeId: string, pathStack: string[]): string[] | null {
    visitState.set(nodeId, 1);
    pathStack.push(nodeId);

    const deps = graph.get(nodeId) || [];
    for (const dep of deps) {
      const state = visitState.get(dep) || 0;
      if (state === 1) {
        // Cycle found
        const cycleStartIndex = pathStack.indexOf(dep);
        return [...pathStack.slice(cycleStartIndex), dep];
      }
      if (state === 0) {
        const cycle = dfs(dep, pathStack);
        if (cycle) return cycle;
      }
    }

    pathStack.pop();
    visitState.set(nodeId, 2);
    return null;
  }

  for (const nodeId of graph.keys()) {
    if ((visitState.get(nodeId) || 0) === 0) {
      const cycle = dfs(nodeId, []);
      if (cycle) {
        throw new WorkerError("CYCLE_DETECTED", `Cycle detected in worker dependencies: ${cycle.join(" -> ")}`);
      }
    }
  }
}

export function findReadyWorkers(workers: WorkerRecord[]): WorkerRecord[] {
  const completedIds = new Set(
    workers.filter((w) => w.status === "completed").map((w) => w.id),
  );

  return workers.filter((worker) => {
    if (worker.status !== "pending") return false;
    const deps = worker.dependsOn || [];
    return deps.every((depId) => completedIds.has(depId));
  });
}

export function findDependentWorkerIds(
  rootWorkerId: string,
  allWorkers: WorkerRecord[],
): Set<string> {
  const dependents = new Set<string>();
  const queue = [rootWorkerId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) break;
    for (const w of allWorkers) {
      if ((w.dependsOn || []).includes(currentId) && !dependents.has(w.id)) {
        dependents.add(w.id);
        queue.push(w.id);
      }
    }
  }

  return dependents;
}
