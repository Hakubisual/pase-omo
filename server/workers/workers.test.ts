import fs from "node:fs";
import { parseArgs } from "../../node_modules/@code-yeongyu/senpi/dist/cli/args.js";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaseoApi, type PaseoTerminalHandle, type PaseoTerminalListResult } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { WorkerRecord } from "../../shared/workers.js";
import { WorkerLifecycleWatcher } from "./worker-lifecycle.js";
import {
  type PaseoTerminalsApi,
  type TerminalCreateOptions,
  type TerminalSnapshot,
  WorkerManager,
} from "./worker-manager.js";
import { WorkerStore } from "./worker-store.js";
import {
  cancelWorker,
  getWorker,
  launchWorkers,
  listWorkers,
  registerWorkerHandlers,
  setWorkerManager,
} from "./workers.js";
import { execGit } from "./worktree.js";

class MockPaseoTerminals implements PaseoTerminalsApi {
  public createdTerminals: TerminalCreateOptions[] = [];
  public killedTerminals: string[] = [];
  private terminalsMap = new Map<string, TerminalSnapshot>();
  private nextId = 1;

  private makeHandle(id: string): PaseoTerminalHandle {
    const map = this.terminalsMap;
    return {
      id,
      current: () => map.get(id) ?? null,
      refresh: async () => map.get(id) ?? null,
      write: () => 0,
      sendKeys: () => 0,
      capture: async () => ({}) as never,
      kill: async () => {
        this.killedTerminals.push(id);
        map.delete(id);
      },
    };
  }

  public async create(options: TerminalCreateOptions): Promise<PaseoTerminalHandle> {
    this.createdTerminals.push(options);
    const id = `term-${this.nextId++}`;
    const snapshot: TerminalSnapshot = {
      id,
      name: options.name ?? "Worker",
      cwd: options.cwd,
      workspaceId: options.workspaceId,
    } as TerminalSnapshot;
    this.terminalsMap.set(id, snapshot);
    return this.makeHandle(id);
  }

  public async list(options?: { workspaceId?: string }): Promise<PaseoTerminalListResult> {
    const list = Array.from(this.terminalsMap.values()).filter(
      (t) => !options?.workspaceId || t.workspaceId === options.workspaceId,
    );
    return {
      requestId: "fixture-list",
      entries: list.map((t) => ({
        id: t.id,
        name: t.name,
        workspaceId: t.workspaceId,
      })) as never,
    };
  }

  public async refKill(terminal: string): Promise<void> {
    await this.ref(terminal).kill();
  }

  public ref(terminal: string): PaseoTerminalHandle {
    if (!this.terminalsMap.has(terminal)) throw new Error(`terminal ${terminal} not found`);
    return this.makeHandle(terminal);
  }
}

function requiredWorker(store: WorkerStore, workspaceId: string, agentId: string, id: string): WorkerRecord {
  const worker = store.getWorker(workspaceId, agentId, id);
  if (!worker) throw new Error(`Missing fixture worker ${id}`);
  return worker;
}

function observeWorker(
  store: WorkerStore, workspaceId: string, agentId: string,
  workerId: string, status: WorkerRecord["status"],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(5000);
    const cleanup = () => {
      store.off("change", changed);
      signal.removeEventListener("abort", aborted);
    };
    const changed = () => {
      if (store.getWorker(workspaceId, agentId, workerId)?.status !== status) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    store.on("change", changed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

describe("OmO Workers Backend Service", () => {
  let tempDir: string;
  let repoDir: string;
  let stateDir: string;
  let mockTerminals: MockPaseoTerminals;
  let store: WorkerStore;
  let lifecycle: WorkerLifecycleWatcher;
  let manager: WorkerManager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-backend-test-"));
    repoDir = path.join(tempDir, "repo");
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Initialize disposable git repository
    await execGit(["init", "-b", "main"], repoDir);
    await execGit(["config", "user.name", "Paseo Tester"], repoDir);
    await execGit(["config", "user.email", "tester@paseo.dev"], repoDir);
    const readme = path.join(repoDir, "README.md");
    fs.writeFileSync(readme, "# OmO Workers Test\n", "utf8");
    await execGit(["add", "README.md"], repoDir);
    await execGit(["commit", "-m", "Initial commit"], repoDir);

    mockTerminals = new MockPaseoTerminals();
    store = new WorkerStore({ storageDir: path.join(stateDir, "store") });
    lifecycle = new WorkerLifecycleWatcher({ stateDir: path.join(stateDir, "lifecycle") });
    manager = new WorkerManager({
      paseo: { terminals: mockTerminals },
      store,
      lifecycle,
      // Pin the runtime so the generated argv has one fixed shape. Resolution
      // otherwise depends on how omo is installed on the host - a PATH shim
      // launches with no script argument while a Bun global install prepends
      // one - and the argv assertions below would then read the wrong slot.
      runtimeConfig: { bunPath: "/test/bun", cliPath: "/test/omo.js" },
    });
    setWorkerManager(manager);
  });

  afterEach(async () => {
    await manager.dispose();
    setWorkerManager(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["--no-approve", "@not-a-file"])("passes prompt %s as literal task text", async prompt => {
    // Given text that the OmO CLI otherwise treats as an option or attachment.
    await manager.launch({
      workspaceId: "ws-argv", agentId: "chat-argv", repoRoot: repoDir,
      workers: [{ id: "argv", title: "Argv", prompt, dependsOn: [] }],
    });
    const args = mockTerminals.createdTerminals[0]?.args;
    if (!args) throw new Error("Missing worker argv");

    // When the real installed OmO parser consumes the generated arguments.
    const parsed = parseArgs(args.slice(1));

    // Then neither trust configuration nor file-loading semantics replace the task.
    expect(parsed.projectTrustOverride).toBe(true);
    expect(parsed.fileArgs).toEqual([]);
    expect(parsed.messages.map(message => message.trimStart())).toEqual([prompt]);
  });

  it("launches batch workers with distinct worktrees, session IDs, and dependency ordering", async () => {
    const launchResult = await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "agent-main-1",
      repoRoot: repoDir,
      workers: [
        {
          id: "worker-1",
          title: "Build Step",
          prompt: "Run build",
          dependsOn: [],
        },
        {
          id: "worker-2",
          title: "Test Step",
          prompt: "Run tests",
          dependsOn: ["worker-1"],
        },
      ],
    });

    expect(launchResult.workers).toHaveLength(2);
    const [w1, w2] = launchResult.workers;
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();

    // Distinct session IDs
    expect(w1?.sessionId).toBeDefined();
    expect(w2?.sessionId).toBeDefined();
    expect(w1?.sessionId).not.toBe(w2?.sessionId);

    // Distinct worktree paths
    expect(w1?.cwd).toContain("worker-1");
    expect(w2?.cwd).toContain("worker-2");
    expect(w1?.cwd).not.toBe(w2?.cwd);

    // Initial states: worker-1 is running with terminal created, worker-2 is pending
    expect(w1?.status).toBe("running");
    expect(w1?.terminalId).toBeDefined();
    expect(w2?.status).toBe("pending");
    expect(w2?.terminalId).toBeUndefined();

    // Mock terminal created for worker-1
    expect(mockTerminals.createdTerminals).toHaveLength(1);
    expect(mockTerminals.createdTerminals[0]?.name).toBe(`OmO: Build Step [${w1?.sessionId}]`);
    expect(mockTerminals.createdTerminals[0]?.args).toContain("--approve");
  });

  it("triggers dependent worker automatically upon explicit completion signal", async () => {
    await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "agent-main-1",
      repoRoot: repoDir,
      workers: [
        { id: "step-1", title: "Step 1", prompt: "p1", dependsOn: [] },
        { id: "step-2", title: "Step 2", prompt: "p2", dependsOn: ["step-1"] },
      ],
    });

    const first = requiredWorker(store, "ws-test-1", "agent-main-1", "step-1");
    const statusFile1 = lifecycle.getStatusFilePath(first.sessionId);

    // Listen for step-2 transitioning to running without fixed sleep
    const step2Started = observeWorker(store, "ws-test-1", "agent-main-1", "step-2", "running");

    // Simulate step-1 completing
    lifecycle.emitStatusUpdate(statusFile1, {
      workerId: "step-1",
      sessionId: first.sessionId,
      status: "completed",
      timestamp: new Date().toISOString(),
    });

    await step2Started;

    const worker1 = store.getWorker("ws-test-1", "agent-main-1", "step-1");
    const worker2 = store.getWorker("ws-test-1", "agent-main-1", "step-2");

    expect(worker1?.status).toBe("completed");
    expect(worker2?.status).toBe("running");
    expect(worker2?.terminalId).toBeDefined();
    expect(mockTerminals.createdTerminals).toHaveLength(2);
  });

  it("cascades failure to dependent pending workers when prerequisite fails", async () => {
    await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "agent-main-1",
      repoRoot: repoDir,
      workers: [
        { id: "step-a", title: "Step A", prompt: "pa", dependsOn: [] },
        { id: "step-b", title: "Step B", prompt: "pb", dependsOn: ["step-a"] },
      ],
    });

    const first = requiredWorker(store, "ws-test-1", "agent-main-1", "step-a");
    const statusFileA = lifecycle.getStatusFilePath(first.sessionId);
    const failed = observeWorker(store, "ws-test-1", "agent-main-1", "step-b", "failed");

    // Emit failure event for step-a
    lifecycle.emitStatusUpdate(statusFileA, {
      workerId: "step-a",
      sessionId: first.sessionId,
      status: "failed",
      error: "Compilation error",
      timestamp: new Date().toISOString(),
    });
    await failed;

    const workerA = store.getWorker("ws-test-1", "agent-main-1", "step-a");
    const workerB = store.getWorker("ws-test-1", "agent-main-1", "step-b");

    expect(workerA?.status).toBe("failed");
    expect(workerA?.error).toBe("Compilation error");
    expect(workerB?.status).toBe("failed");
    expect(workerB?.error).toContain("Prerequisite worker \"step-a\" failed");
  });

  it("isolates workers between different main chat agents and rejects foreign control", async () => {
    await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "chat-alpha",
      repoRoot: repoDir,
      workers: [{ id: "worker-alpha", title: "Alpha Task", prompt: "p", dependsOn: [] }],
    });

    // Chat Beta lists workers - must be empty
    const betaList = manager.list({ workspaceId: "ws-test-1", agentId: "chat-beta" });
    expect(betaList.workers).toHaveLength(0);

    // Chat Beta tries to get Alpha's worker - returns null
    const getResult = manager.get({
      workspaceId: "ws-test-1",
      agentId: "chat-beta",
      workerId: "worker-alpha",
    });
    expect(getResult.worker).toBeNull();

    // Chat Beta tries to cancel Alpha's worker - rejected with error
    await expect(
      manager.cancel({
        workspaceId: "ws-test-1",
        agentId: "chat-beta",
        workerId: "worker-alpha",
      }),
    ).rejects.toThrow(/Worker with ID "worker-alpha" not found/);
  });

  it("keeps the same local worker ID isolated across two main chats", async () => {
    // Given one main chat using a local task ID.
    const first = await manager.launch({
      workspaceId: "ws-shared",
      agentId: "chat-one",
      repoRoot: repoDir,
      workers: [{ id: "build", title: "Build", prompt: "build", dependsOn: [] }],
    });

    // When another main chat independently uses that task ID.
    const second = await manager.launch({
      workspaceId: "ws-shared",
      agentId: "chat-two",
      repoRoot: repoDir,
      workers: [{ id: "build", title: "Build", prompt: "build", dependsOn: [] }],
    });

    // Then neither worktrees nor branches nor lifecycle files are shared.
    expect(second.workers[0]?.cwd).not.toBe(first.workers[0]?.cwd);
    expect(second.workers[0]?.branch).not.toBe(first.workers[0]?.branch);
    expect(mockTerminals.createdTerminals[1]?.args).not.toEqual(mockTerminals.createdTerminals[0]?.args);
  });

  it("records terminal launch failure and blocks its dependents", async () => {
    // Given a daemon that refuses to create the first worker terminal.
    vi.spyOn(mockTerminals, "create").mockRejectedValueOnce(new Error("PTY unavailable"));

    // When a dependency batch is launched.
    const result = await manager.launch({
      workspaceId: "ws-failure",
      agentId: "chat-failure",
      repoRoot: repoDir,
      workers: [
        { id: "build", title: "Build", prompt: "build", dependsOn: [] },
        { id: "test", title: "Test", prompt: "test", dependsOn: ["build"] },
      ],
    });

    // Then no worker remains falsely preparing or starts after the failed prerequisite.
    expect(result.workers.map(worker => worker.status)).toEqual(["failed", "failed"]);
    expect(result.workers[0]?.error).toBe("PTY unavailable");
    expect(mockTerminals.createdTerminals).toHaveLength(0);
  });

  it("reports a lost terminal as failed on the next list request", async () => {
    // Given a launched terminal that disappears without a worker completion signal.
    await manager.launch({
      workspaceId: "ws-lost", agentId: "chat-lost", repoRoot: repoDir,
      workers: [{ id: "lost", title: "Lost", prompt: "work", dependsOn: [] }],
    });
    const worker = requiredWorker(store, "ws-lost", "chat-lost", "lost");
    if (!worker.terminalId) throw new Error("Missing fixture terminal");
    await mockTerminals.refKill(worker.terminalId);
    const context = {
      paseo: {
        ...createPaseoApi(new DaemonClient({
          url: "ws://fixture.invalid", clientId: "list-fixture", reconnect: { enabled: false },
        })),
        terminals: mockTerminals,
      },
    };

    // When the visible panel refreshes.
    const result = await listWorkers({ workspaceId: "ws-lost", agentId: "chat-lost" }, context);

    // Then liveness loss is explicit, never success or an indefinitely running task.
    expect(result.workers[0]?.status).toBe("failed");
  });

  it("cancels running worker and downstream dependents while killing the terminal", async () => {
    await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "agent-1",
      repoRoot: repoDir,
      workers: [
        { id: "parent-task", title: "Parent", prompt: "p", dependsOn: [] },
        { id: "child-task", title: "Child", prompt: "c", dependsOn: ["parent-task"] },
      ],
    });

    const cancelResult = await manager.cancel({
      workspaceId: "ws-test-1",
      agentId: "agent-1",
      workerId: "parent-task",
    });

    expect(cancelResult.worker.status).toBe("cancelled");
    expect(mockTerminals.killedTerminals).toContain(cancelResult.worker.terminalId);

    const child = store.getWorker("ws-test-1", "agent-1", "child-task");
    expect(child?.status).toBe("cancelled");
  });

  it("recovers without duplicate launches on reload", async () => {
    await manager.launch({
      workspaceId: "ws-test-1",
      agentId: "agent-reload",
      repoRoot: repoDir,
      workers: [{ id: "task-persist", title: "Persistent", prompt: "p", dependsOn: [] }],
    });

    expect(mockTerminals.createdTerminals).toHaveLength(1);

    // Close the original process resources and load fresh persisted state.
    await manager.dispose();
    const reloadedManager = new WorkerManager({
      paseo: { terminals: mockTerminals },
      store: new WorkerStore({ storageDir: path.join(stateDir, "store") }),
      lifecycle: new WorkerLifecycleWatcher({ stateDir: path.join(stateDir, "lifecycle") }),
    });

    await reloadedManager.recoverOnReload("ws-test-1");

    // No duplicate terminal created
    expect(mockTerminals.createdTerminals).toHaveLength(1);

    const list = reloadedManager.list({ workspaceId: "ws-test-1", agentId: "agent-reload" });
    expect(list.workers).toHaveLength(1);
    expect(list.workers[0]?.id).toBe("task-persist");
    expect(list.workers[0]?.status).toBe("running");

    await reloadedManager.dispose();
  });

  it("handles RPC handlers via PluginHandlerContext correctly", async () => {
    const fakeContext = {
      paseo: {
        ...createPaseoApi(new DaemonClient({
          url: "ws://fixture.invalid", clientId: "rpc-fixture", reconnect: { enabled: false },
        })),
        terminals: mockTerminals,
      },
    };

    const launchRes = await launchWorkers(
      {
        workspaceId: "ws-rpc",
        agentId: "agent-rpc",
        repoRoot: repoDir,
        workers: [{ id: "rpc-worker", title: "RPC Worker", prompt: "do rpc", dependsOn: [] }],
      },
      fakeContext,
    );
    expect(launchRes.workers).toHaveLength(1);

    const listRes = await listWorkers(
      { workspaceId: "ws-rpc", agentId: "agent-rpc" },
      fakeContext,
    );
    expect(listRes.workers).toHaveLength(1);

    const getRes = await getWorker(
      { workspaceId: "ws-rpc", agentId: "agent-rpc", workerId: "rpc-worker" },
      fakeContext,
    );
    expect(getRes.worker?.id).toBe("rpc-worker");

    const cancelRes = await cancelWorker(
      { workspaceId: "ws-rpc", agentId: "agent-rpc", workerId: "rpc-worker" },
      fakeContext,
    );
    expect(cancelRes.worker.status).toBe("cancelled");
  });

  it("registers and cleans up plugin handlers", () => {
    const handledRpcNames: string[] = [];
    const fakePlugin: Pick<PluginServerContext, "handle"> = {
      handle: (contract) => {
        handledRpcNames.push(contract.name);
      },
    };

    const cleanup = registerWorkerHandlers(fakePlugin, manager);
    expect(handledRpcNames).toEqual([
      "workers.launch",
      "workers.list",
      "workers.cancel",
      "workers.get",
    ]);

    expect(typeof cleanup).toBe("function");
  });
});
