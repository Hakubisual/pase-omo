import type { DagSnapshotPayload } from "../../shared/dag.js";
import { beforeEach, expect, test, vi } from "vitest";
import { sdkContext } from "./sdk-context.test-support.js";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string; sessionId: string }>,
  snapshot: null as DagSnapshotPayload | null,
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
  harness.calls = [];
  harness.snapshot = null;
});

test("resolves daemon-local cwd and session through the caller SDK", async () => {
  const sdk = sdkContext("E:/daemon/project", "session-current");
  harness.snapshot = { sessionId: "session-current", runs: [], tasks: [] };
  await expect(agentDagSnapshot({ agentId: "agent-1" }, sdk.context)).resolves.toEqual(harness.snapshot);
  expect(sdk.refresh).toHaveBeenCalledTimes(1);
  expect(harness.calls).toEqual([{
    cwd: "E:/daemon/project", sessionId: "session-current",
    sessionFile: "/sessions/2026-09-15T00-00-00_session-current.jsonl",
  }]);
});

test("an unresolved remote agent does not borrow another session", async () => {
  const sdk = sdkContext("E:/daemon/project", null);
  await expect(agentDagSnapshot({ agentId: "agent-1" }, sdk.context)).resolves.toEqual({
    sessionId: null, runs: [], tasks: [],
  });
  expect(harness.calls).toEqual([]);
});

test("snapshot fetch errors reach the RPC caller", async () => {
  const sdk = sdkContext("E:/daemon/project");
  const error = new Error("SDK disconnected");
  sdk.refresh.mockRejectedValue(error);
  await expect(agentDagSnapshot({ agentId: "agent-1" }, sdk.context)).rejects.toBe(error);
  expect(harness.calls).toEqual([]);
});
