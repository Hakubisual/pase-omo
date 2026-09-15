import { describe, expect, it } from "vitest";
import { findDependentWorkerIds, findReadyWorkers, validateBatch } from "./dag.js";
import type { WorkerItemSpec, WorkerRecord } from "../../shared/workers.js";

describe("DAG dependency validator and scheduler", () => {
  it("validates a simple valid DAG batch", () => {
    const batch: WorkerItemSpec[] = [
      { id: "task-1", title: "Task 1", prompt: "p1", dependsOn: [] },
      { id: "task-2", title: "Task 2", prompt: "p2", dependsOn: ["task-1"] },
      { id: "task-3", title: "Task 3", prompt: "p3", dependsOn: ["task-1"] },
      { id: "task-4", title: "Task 4", prompt: "p4", dependsOn: ["task-2", "task-3"] },
    ];

    expect(() => validateBatch(batch)).not.toThrow();
  });

  it("rejects duplicate IDs within the batch", () => {
    const batch: WorkerItemSpec[] = [
      { id: "duplicate-id", title: "Task 1", prompt: "p1", dependsOn: [] },
      { id: "duplicate-id", title: "Task 2", prompt: "p2", dependsOn: [] },
    ];

    expect(() => validateBatch(batch)).toThrowError(/Duplicate worker ID in batch: "duplicate-id"/);
  });

  it("rejects worker colliding with active existing worker", () => {
    const existing: WorkerRecord[] = [
      {
        id: "active-worker",
        agentId: "agent-1",
        workspaceId: "ws-1",
        sessionId: "00000000-0000-0000-0000-000000000001",
        title: "Active",
        prompt: "p",
        cwd: "/tmp/cwd",
        repoRoot: "/tmp",
        branch: "branch",
        dependsOn: [],
        status: "running",
        createdAt: new Date().toISOString(),
      },
    ];

    const batch: WorkerItemSpec[] = [
      { id: "active-worker", title: "New", prompt: "p", dependsOn: [] },
    ];

    expect(() => validateBatch(batch, existing)).toThrowError(
      /Worker with ID "active-worker" is already active/,
    );
  });

  it("rejects reusing a completed worker ID instead of aliasing its history", () => {
    const existing: WorkerRecord = {
      id: "build", workspaceId: "workspace", agentId: "chat",
      sessionId: "10000000-0000-4000-8000-000000000001", title: "Build", prompt: "build",
      cwd: "/repo/worker", repoRoot: "/repo", branch: "worker", dependsOn: [],
      status: "completed", createdAt: "2026-09-09T00:00:00.000Z",
    };
    expect(() => validateBatch(
      [{ id: "build", title: "New", prompt: "new", dependsOn: [] }], [existing],
    )).toThrow();
  });

  it("rejects unknown dependencies", () => {
    const batch: WorkerItemSpec[] = [
      { id: "task-1", title: "Task 1", prompt: "p1", dependsOn: ["non-existent"] },
    ];

    expect(() => validateBatch(batch)).toThrowError(/Unknown dependency.*non-existent/);
  });

  it("rejects self-dependencies", () => {
    const batch: WorkerItemSpec[] = [
      { id: "task-1", title: "Task 1", prompt: "p1", dependsOn: ["task-1"] },
    ];

    expect(() => validateBatch(batch)).toThrowError(/depends on itself/);
  });

  it("rejects direct circular dependencies (A <-> B)", () => {
    const batch: WorkerItemSpec[] = [
      { id: "a", title: "Task A", prompt: "pa", dependsOn: ["b"] },
      { id: "b", title: "Task B", prompt: "pb", dependsOn: ["a"] },
    ];

    expect(() => validateBatch(batch)).toThrowError(/Cycle detected in worker dependencies/);
  });

  it("rejects transitive circular dependencies (A -> B -> C -> A)", () => {
    const batch: WorkerItemSpec[] = [
      { id: "a", title: "Task A", prompt: "pa", dependsOn: ["b"] },
      { id: "b", title: "Task B", prompt: "pb", dependsOn: ["c"] },
      { id: "c", title: "Task C", prompt: "pc", dependsOn: ["a"] },
    ];

    expect(() => validateBatch(batch)).toThrowError(/Cycle detected in worker dependencies/);
  });

  it("finds ready workers whose dependencies are completed", () => {
    const now = new Date().toISOString();
    const workers: WorkerRecord[] = [
      {
        id: "w1",
        agentId: "agent-1",
        workspaceId: "ws-1",
        sessionId: "00000000-0000-0000-0000-000000000001",
        title: "W1",
        prompt: "p",
        cwd: "/tmp/1",
        repoRoot: "/tmp",
        branch: "b1",
        dependsOn: [],
        status: "completed",
        createdAt: now,
      },
      {
        id: "w2",
        agentId: "agent-1",
        workspaceId: "ws-1",
        sessionId: "00000000-0000-0000-0000-000000000002",
        title: "W2",
        prompt: "p",
        cwd: "/tmp/2",
        repoRoot: "/tmp",
        branch: "b2",
        dependsOn: ["w1"],
        status: "pending",
        createdAt: now,
      },
      {
        id: "w3",
        agentId: "agent-1",
        workspaceId: "ws-1",
        sessionId: "00000000-0000-0000-0000-000000000003",
        title: "W3",
        prompt: "p",
        cwd: "/tmp/3",
        repoRoot: "/tmp",
        branch: "b3",
        dependsOn: ["w2"],
        status: "pending",
        createdAt: now,
      },
    ];

    const ready = findReadyWorkers(workers);
    expect(ready.map((w) => w.id)).toEqual(["w2"]);
  });

  it("finds all downstream dependent workers", () => {
    const now = new Date().toISOString();
    const workers: WorkerRecord[] = [
      {
        id: "w1",
        agentId: "a",
        workspaceId: "ws",
        sessionId: "00000000-0000-0000-0000-000000000001",
        title: "W1",
        prompt: "p",
        cwd: "/tmp/1",
        repoRoot: "/tmp",
        branch: "b1",
        dependsOn: [],
        status: "running",
        createdAt: now,
      },
      {
        id: "w2",
        agentId: "a",
        workspaceId: "ws",
        sessionId: "00000000-0000-0000-0000-000000000002",
        title: "W2",
        prompt: "p",
        cwd: "/tmp/2",
        repoRoot: "/tmp",
        branch: "b2",
        dependsOn: ["w1"],
        status: "pending",
        createdAt: now,
      },
      {
        id: "w3",
        agentId: "a",
        workspaceId: "ws",
        sessionId: "00000000-0000-0000-0000-000000000003",
        title: "W3",
        prompt: "p",
        cwd: "/tmp/3",
        repoRoot: "/tmp",
        branch: "b3",
        dependsOn: ["w2"],
        status: "pending",
        createdAt: now,
      },
      {
        id: "w4",
        agentId: "a",
        workspaceId: "ws",
        sessionId: "00000000-0000-0000-0000-000000000004",
        title: "W4",
        prompt: "p",
        cwd: "/tmp/4",
        repoRoot: "/tmp",
        branch: "b4",
        dependsOn: [],
        status: "pending",
        createdAt: now,
      },
    ];

    const dependents = findDependentWorkerIds("w1", workers);
    expect(Array.from(dependents).sort()).toEqual(["w2", "w3"]);
  });
});
