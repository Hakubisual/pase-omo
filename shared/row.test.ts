import { expect, test } from "vitest";
import { agentDagSnapshotRpc, DagRowSchema, rowSignature, type DagRow } from "./row";

/**
 * The signature decides whether a run is republished, so it has to cover
 * everything the card draws. A field the renderer shows but the signature
 * ignores is a card that silently stops matching its run.
 */

const row = (overrides: Partial<DagRow> = {}): DagRow => ({
  runId: "run-1",
  name: "build",
  status: "running",
  updatedAt: "2026-09-15T00:00:00.000Z",
  total: 2,
  completed: 1,
  running: 1,
  failed: 0,
  layers: [[{ id: "n1", label: "plan", state: "completed" }]],
  edges: [],
  truncated: false,
  ...overrides,
});

test.each([
  ["a rename", row({ name: "release" })],
  ["a node label", row({ layers: [[{ id: "n1", label: "plan twice", state: "completed" }]] })],
  ["a node state", row({ layers: [[{ id: "n1", label: "plan", state: "failed" }]] })],
  ["a run status", row({ status: "failed" })],
  ["a progress count", row({ completed: 2 })],
  ["a truncation notice", row({ truncated: true })],
  ["a dependency link", row({ edges: [{ from: "n1", to: "n2" }] })],
])("%s changes the signature", (_case, changed) => {
  expect(rowSignature(changed)).not.toBe(rowSignature(row()));
});

test("a card published before dependency links existed still renders", () => {
  // Rows already sitting in the daemon timeline were serialised without edges.
  // The renderer validates data against this schema, so a missing field has to
  // read as "no links known" rather than turning the card into an error state.
  const { edges: _dropped, ...legacy } = row();

  expect(DagRowSchema.parse(legacy).edges).toEqual([]);
});

test("a write that changes nothing on the card keeps the signature", () => {
  expect(rowSignature(row({ updatedAt: "2026-09-15T01:00:00.000Z" }))).toBe(rowSignature(row()));
});

test("the agent DAG snapshot RPC is keyed only by remote-safe agent identity", () => {
  expect(agentDagSnapshotRpc.input.safeParse({ agentId: "agent-1" }).success).toBe(true);
  expect(
    agentDagSnapshotRpc.input.parse({ agentId: "agent-1", cwd: "E:/daemon-only" }),
  ).toEqual({ agentId: "agent-1" });
  expect(agentDagSnapshotRpc.input.safeParse({ agentId: "" }).success).toBe(false);
  expect(
    agentDagSnapshotRpc.output.safeParse({ sessionId: null, runs: [], tasks: [] }).success,
  ).toBe(true);
});
