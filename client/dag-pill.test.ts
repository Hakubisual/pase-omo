import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contributeDagPill, listedAgents } from "./dag-pill.js";
import type { DagRow } from "../shared/row.js";

/**
 * The pill is driven by `agents.subscribe`, which is the agent-update stream.
 * A DAG run owned by an idle agent advances on disk without producing any agent
 * update, so the subscription alone can leave a stale count on screen. These
 * tests pin the bounded backstop that covers that gap, and pin that it stops
 * once nothing is running, so an idle session still does no periodic work.
 */

const row = (overrides: Partial<DagRow> = {}): DagRow => ({
  runId: "run-1",
  name: "run",
  status: "running",
  updatedAt: "2026-09-15T00:00:00.000Z",
  total: 5,
  completed: 1,
  running: 1,
  failed: 0,
  layers: [],
  edges: [],
  truncated: false,
  ...overrides,
});

let rows: DagRow[];
let rpcCalls: number;
let unsubscribed: number;
let rpcFails: boolean;

function stubClient(): PluginClientContext {
  const agent = { id: "agent-1", provider: "omo", workspaceId: "wks-1" };
  return {
    addComposerPill: () => ({ update: () => {}, remove: () => {} }),
    rpc: async () => {
      rpcCalls += 1;
      if (rpcFails) throw new Error("run store unreadable");
      return { rows };
    },
    paseo: {
      agents: {
        list: async () => ({ entries: [{ agent }] }),
        subscribe: () => () => {
          unsubscribed += 1;
        },
      },
    },
  } as unknown as PluginClientContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  rows = [row()];
  rpcCalls = 0;
  unsubscribed = 0;
  rpcFails = false;
});

it("normalizes pill registration data without exposing provider-local runtime paths", () => {
  const [agent] = listedAgents({
    entries: [
      {
        agent: {
          id: "agent-1",
          provider: "omo",
          workspaceId: "wks-1",
          runtimeInfo: {
            sessionId:
              'omo {"data":{"sessionFile":"/sessions/2026-09-15T00-00-00_session-current.jsonl"}}',
          },
        },
      },
    ],
  });

  expect(agent).toEqual({ id: "agent-1", provider: "omo", workspaceId: "wks-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps refreshing a running DAG that produces no agent updates", async () => {
  const dispose = contributeDagPill(stubClient());
  await vi.advanceTimersByTimeAsync(0);
  expect(rpcCalls).toBe(1);

  await vi.advanceTimersByTimeAsync(3_000);
  expect(rpcCalls).toBe(2);

  await vi.advanceTimersByTimeAsync(3_000);
  expect(rpcCalls).toBe(3);

  dispose();
});

/**
 * The backend answers a broken run store with a failure instead of an empty
 * list, and that failure reaches the pill through the RPC. Reading it as
 * "nothing is running" would retire the backstop and leave the count frozen
 * until the agent happens to emit an update.
 */
it("keeps the backstop armed when a refresh fails", async () => {
  const failures = vi.spyOn(console, "error").mockImplementation(() => {});
  const dispose = contributeDagPill(stubClient());
  await vi.advanceTimersByTimeAsync(0);
  expect(rpcCalls).toBe(1);

  rpcFails = true;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(rpcCalls).toBe(2);

  rpcFails = false;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(rpcCalls).toBe(3);
  expect(failures).toHaveBeenCalledOnce();

  dispose();
  failures.mockRestore();
});

it("stops refreshing once no run is live, and after disposal", async () => {
  const dispose = contributeDagPill(stubClient());
  await vi.advanceTimersByTimeAsync(0);
  expect(rpcCalls).toBe(1);

  rows = [row({ status: "completed", completed: 5, running: 0 })];
  await vi.advanceTimersByTimeAsync(3_000);
  expect(rpcCalls).toBe(2);

  // Nothing is running anymore, so no further backstop is armed.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(rpcCalls).toBe(2);

  rows = [row()];
  dispose();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(rpcCalls).toBe(2);
  expect(unsubscribed).toBe(1);
});
