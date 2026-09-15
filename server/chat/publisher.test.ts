import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPublisher } from "./publisher.js";

/**
 * The publisher polls the run store while a turn is live and appends one
 * timeline card per run, drawn when the run settles (see dag-one-card.test.ts
 * for that contract). These tests pin the three ways that loop used to outlive
 * or under-serve its agent: a session record the daemon had not written yet, a
 * teardown that an in-flight append ran past, and per-agent state the process
 * kept for as long as it lived.
 */

const SESSION = "sess-1";
/** Mirrors the publisher's own grace window. */
const GRACE_MS = 90 * 1000;

const roots: string[] = [];
let appends: { id: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  appends = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-chat-publisher-"));
  roots.push(root);
  const cwd = join(root, "project");
  const paseoHome = join(root, "paseo");
  vi.stubEnv("PASEO_HOME", paseoHome);
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", "");
  vi.stubEnv("OMO_HERDR_DAG_TASK_STATE_DIR", "");

  const write = async (file: string, body: string): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  const saveRun = (runId: string, status = "running"): Promise<void> =>
    write(
      join(cwd, ".omo", "senpi-task", "dag", "runs", `${runId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        parentSessionId: SESSION,
        name: runId,
        status,
        updatedAt: new Date(Date.now()).toISOString(),
        nodes: [{ id: "n1", label: "node", state: status === "completed" ? "completed" : "running" }],
      }),
    );
  const saveAgentRecord = (): Promise<void> =>
    write(
      join(paseoHome, "agents", "group", "agent-1.json"),
      JSON.stringify({
        cwd,
        runtimeInfo: {
          sessionId: `omo ${JSON.stringify({ data: { sessionFile: `/sessions/2026-09-15T00-00-00_${SESSION}.jsonl` } })}`,
        },
      }),
    );

  const agent: PluginHookAgent = {
    id: "agent-1",
    workspaceId: "wks-1",
    parentAgentId: null,
    provider: "omo",
    cwd,
    title: null,
  };
  return { agent, saveRun, saveAgentRecord };
}

/** Records every appended row; `onAppend` can hold one open. */
function stubContext(onAppend?: (index: number) => Promise<void>): PluginHookContext {
  const timeline = {
    append: async (item: { id: string }) => {
      appends.push(item);
      await onAppend?.(appends.length);
      return { seq: appends.length, epoch: "epoch-1" };
    },
  };
  return {
    paseo: { agents: { ref: () => ({ timeline }) } },
    signal: new AbortController().signal,
  } as unknown as PluginHookContext;
}

test("a session record the daemon has not written yet resolves on a later tick", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveRun("dag_1");
  const context = stubContext();
  const publisher = createPublisher();

  // The agent exists before its runtime record does, so the first lookup misses.
  await publisher.onTurnStarted(agent, context);
  expect(appends).toEqual([]);

  await saveAgentRecord();
  await publisher.onTurnEnded(agent, context);
  // The run is still working, so its card is drawn when the watch retires.
  await vi.advanceTimersByTimeAsync(GRACE_MS + 1000);
  await publisher.settle();

  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);
  publisher.dispose();
});

test("disposal stops the publisher mid-run instead of finishing the batch", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  // Settled, so the first read has cards to draw and the hold below lands
  // inside an append rather than never happening.
  await saveRun("dag_1", "completed");
  await saveRun("dag_2", "completed");

  let entered!: () => void;
  const firstAppend = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publisher = createPublisher();
  const context = stubContext(async (index) => {
    if (index !== 1) return;
    entered();
    await held;
  });

  const turn = publisher.onTurnStarted(agent, context);
  await firstAppend;
  publisher.dispose();
  release();
  await turn;

  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);
});

test("a run that did not change is not republished after the grace window closes", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  await saveRun("dag_1");
  const context = stubContext();
  const publisher = createPublisher();

  await publisher.onTurnStarted(agent, context);
  await publisher.onTurnEnded(agent, context);
  // A run still in motion is the pill's business, so nothing is drawn yet.
  expect(appends).toEqual([]);

  await vi.advanceTimersByTimeAsync(GRACE_MS);
  await publisher.settle();
  expect(appends).toHaveLength(1);

  await publisher.onTurnStarted(agent, context);
  await publisher.settle();

  // The polling watch is gone, but the published signatures are NOT: Paseo's
  // timeline store appends every item under a fresh seq (agent-timeline-store
  // append() pushes a new row), so re-appending the same `dag-<runId>` adds a
  // SECOND rendered card instead of replacing the first one. That is the
  // repeated-card symptom this plugin exists to avoid, so an unchanged run
  // stays unpublished across turns.
  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);
  publisher.dispose();
});
