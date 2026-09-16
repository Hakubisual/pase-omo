import { expect, test } from "vitest";

import { nodeForTask } from "./dag.js";
import {
  consumeDagDestination,
  destinationSelection,
  openInDagDashboard,
  peekDagDestination,
  setDagNavigationHost,
  subscribeDagDestination,
} from "./dag-navigation.js";
import type { DagRun } from "../shared/dag.js";

/**
 * The host opens a plugin panel by id and carries no payload with it, so an
 * "Open in OmO DAG" press parks its destination here and the panel picks it up.
 * These cover the parts of that handover that decide whether the user lands on
 * their own session: the park/consume cycle, the "is it still listed" answer,
 * and the node a navigated-to task belongs to.
 */

const run: DagRun = {
  id: "dag_1",
  name: "run",
  status: "running",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:01:00.000Z",
  nodes: [
    { id: "a", label: "a", state: "running", attempt: 0, taskId: "st_a", error: "" },
    { id: "b", label: "b", state: "pending", attempt: 0, error: "" },
  ],
  edges: [],
};

test("a parked destination is delivered once and then gone", async () => {
  const destination = { cwd: "E:/project", sessionId: "session-a", runId: "dag_1" };
  let notifications = 0;
  const unsubscribe = subscribeDagDestination(() => {
    notifications += 1;
  });

  setDagNavigationHost({
    rpc: async () => ({ destination }),
    openPanel: () => {},
    paseo: { agents: { list: async () => [{ id: "agent-1", workspaceId: "workspace-1" }] } },
  } as never);

  await expect(openInDagDashboard({ agentId: "agent-1", runId: "dag_1" })).resolves.toEqual({
    ok: true,
  });
  expect(peekDagDestination("E:/project")).toEqual(destination);
  expect(notifications).toBe(1);

  consumeDagDestination("E:/project");
  expect(peekDagDestination("E:/project")).toBeNull();
  expect(notifications).toBe(2);

  unsubscribe();
  setDagNavigationHost(null);
});

test("a destination the daemon cannot resolve reports its reason and opens nothing", async () => {
  let opened = 0;
  setDagNavigationHost({
    rpc: async () => ({ destination: null, reason: "Session gone-1 is not listed for this workspace anymore." }),
    openPanel: () => {
      opened += 1;
    },
    paseo: { agents: { list: async () => [] } },
  } as never);

  await expect(openInDagDashboard({ agentId: "agent-1" })).resolves.toEqual({
    ok: false,
    reason: "Session gone-1 is not listed for this workspace anymore.",
  });
  expect(opened).toBe(0);
  expect(peekDagDestination("E:/project")).toBeNull();

  setDagNavigationHost(null);
});

test("without a host the button says so rather than throwing", async () => {
  setDagNavigationHost(null);
  const result = await openInDagDashboard({ agentId: "agent-1" });
  expect(result.ok).toBe(false);
});

test("a destination whose session is not listed is answered, not silently swapped", () => {
  const destination = { cwd: "E:/project", sessionId: "session-a" };

  expect(destinationSelection(destination, [{ id: "session-a" }, { id: "session-b" }])).toEqual({
    sessionId: "session-a",
    listed: true,
  });
  expect(destinationSelection(destination, [{ id: "session-b" }])).toEqual({
    sessionId: "session-a",
    listed: false,
  });
});

test("a task resolves to the DAG node that spawned it", () => {
  expect(nodeForTask([run], "st_a")).toEqual({ runId: "dag_1", nodeId: "a" });
  expect(nodeForTask([run], "st_missing")).toBeNull();
});
