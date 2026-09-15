import type { DagSnapshotPayload } from "../../shared/dag.js";
import { beforeEach, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  origin: { cwd: null as string | null, sessionId: null as string | null },
  calls: [] as Array<{ cwd: string; sessionId: string }>,
  snapshot: null as DagSnapshotPayload | null,
}));

vi.mock("./runs.js", () => ({
  readRows: async () => [],
  resolveAgent: async () => harness.origin,
  resolveSessionId: async () => harness.origin.sessionId,
}));

vi.mock("../dag/dag-store.js", () => ({
  getDagSnapshot: async (input: { cwd: string; sessionId: string }) => {
    harness.calls.push(input);
    if (!harness.snapshot) throw new Error("missing snapshot fixture");
    return harness.snapshot;
  },
}));

import { agentDagSnapshot } from "./publisher.js";

beforeEach(() => {
  harness.origin = { cwd: null, sessionId: null };
  harness.calls = [];
  harness.snapshot = null;
});

test("resolves daemon-local cwd and session data on the server from only an agent id", async () => {
  harness.origin = { cwd: "E:/daemon/project", sessionId: "session-current" };
  harness.snapshot = { sessionId: "session-current", runs: [], tasks: [] };

  await expect(agentDagSnapshot({ agentId: "agent-1" })).resolves.toEqual(harness.snapshot);
  expect(harness.calls).toEqual([
    { cwd: "E:/daemon/project", sessionId: "session-current" },
  ]);
});

test("an unresolved remote agent returns an empty snapshot without borrowing another session", async () => {
  await expect(agentDagSnapshot({ agentId: "agent-1" })).resolves.toEqual({
    sessionId: null,
    runs: [],
    tasks: [],
  });
  expect(harness.calls).toEqual([]);
});
