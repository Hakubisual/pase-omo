import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DagRow } from "../../shared/row.js";

const runStore = vi.hoisted(() => ({
  row: null as DagRow | null,
}));

vi.mock("./runs.js", () => ({
  resolveSessionId: async () => "session-current",
  readRows: async () => (runStore.row ? [runStore.row] : []),
}));

import { createPublisher } from "./publisher.js";

const GRACE_MS = 90 * 1000;
const agent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  parentAgentId: null,
  provider: "omo",
  cwd: "E:/project",
  title: null,
} satisfies PluginHookAgent;

const row = (updatedAt: string): DagRow => ({
  runId: "run-1",
  name: "eval",
  status: "running",
  updatedAt,
  total: 1,
  completed: 0,
  running: 1,
  failed: 0,
  layers: [[{ id: "eval", label: "eval", state: "running" }]],
  edges: [],
  truncated: false,
});

let appends: string[];

function context(): PluginHookContext {
  return {
    paseo: {
      agents: {
        ref: () => ({
          timeline: {
            append: async (item: { id: string }) => {
              appends.push(item.id);
              return { seq: appends.length, epoch: "epoch-1" };
            },
          },
        }),
      },
    },
    signal: new AbortController().signal,
  } as unknown as PluginHookContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  appends = [];
  runStore.row = row("2026-09-15T00:00:00.000Z");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function publishAgainAfterWatchRetirement(next: DagRow): Promise<void> {
  const publisher = createPublisher();
  const hookContext = context();

  await publisher.onTurnStarted(agent, hookContext);
  await publisher.onTurnEnded(agent, hookContext);
  await vi.advanceTimersByTimeAsync(GRACE_MS);

  runStore.row = next;
  await publisher.onTurnStarted(agent, hookContext);
  publisher.dispose();
}

test("publishing the same logical run in a later turn keeps one timeline card", async () => {
  await publishAgainAfterWatchRetirement(row("2026-09-15T00:00:00.000Z"));

  expect(appends).toEqual(["dag-run-1"]);
});

test("a non-rendered timestamp change in a later turn does not append a duplicate card", async () => {
  await publishAgainAfterWatchRetirement(row("2026-09-15T01:00:00.000Z"));

  expect(appends).toEqual(["dag-run-1"]);
});
