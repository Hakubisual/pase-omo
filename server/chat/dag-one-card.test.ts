import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPublisher } from "./publisher.js";

/**
 * One card per run, and it is the run being worked on.
 *
 * Paseo's timeline handle can only APPEND - there is no update or replace - so
 * every publication is another rendered card. Publishing on each state change
 * therefore walked a ten-node run down the chat as ten near-identical graphs,
 * which on a phone is a screen of history hiding the live one. The card is
 * published once, in the state the run settled in; live progress belongs to the
 * composer pill, which re-renders in place instead of appending.
 */

const SESSION = "sess-1";
/** Mirrors the publisher's own grace window. */
const GRACE_MS = 90 * 1000;

const roots: string[] = [];
let appends: { id: string; data: { status: string; completed: number; total: number } }[];

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
  const root = await mkdtemp(join(tmpdir(), "omo-one-card-"));
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

  /** Writes the run in a given state; calling it again is that run progressing. */
  const saveRun = (runId: string, status: string, doneNodes: number): Promise<void> =>
    write(
      join(cwd, ".omo", "senpi-task", "dag", "runs", `${runId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        parentSessionId: SESSION,
        name: runId,
        status,
        updatedAt: new Date(Date.now()).toISOString(),
        nodes: [0, 1, 2].map((index) => ({
          id: `n${index}`,
          label: `node ${index}`,
          state: index < doneNodes ? "completed" : index === doneNodes && status === "running" ? "running" : "pending",
        })),
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

function stubContext(): PluginHookContext {
  const timeline = {
    append: async (item: { id: string }) => {
      appends.push(item as (typeof appends)[number]);
      return { seq: appends.length, epoch: "epoch-1" };
    },
  };
  return {
    paseo: { agents: { ref: () => ({ timeline }) } },
    signal: new AbortController().signal,
  } as unknown as PluginHookContext;
}

test("a run that works its way through its nodes leaves exactly one card", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  const context = stubContext();
  const publisher = createPublisher();

  await saveRun("dag_1", "running", 0);
  await publisher.onTurnStarted(agent, context);

  // The run moves: each of these used to be another card in the conversation.
  await saveRun("dag_1", "running", 1);
  await vi.advanceTimersByTimeAsync(2000);
  await saveRun("dag_1", "running", 2);
  await vi.advanceTimersByTimeAsync(2000);
  await saveRun("dag_1", "completed", 3);
  await vi.advanceTimersByTimeAsync(2000);

  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);
  // And the single card carries the state the run actually ended in.
  expect(appends[0]?.data.status).toBe("completed");
  expect(appends[0]?.data.completed).toBe(3);
  publisher.dispose();
});

test("nothing is drawn while the run is still working, because the pill is the live surface", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  const context = stubContext();
  const publisher = createPublisher();

  await saveRun("dag_1", "running", 1);
  await publisher.onTurnStarted(agent, context);
  await vi.advanceTimersByTimeAsync(5000);

  expect(appends).toEqual([]);
  publisher.dispose();
});

test("a run still working when the watch retires is drawn once, so the chat is not left empty", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  const context = stubContext();
  const publisher = createPublisher();

  await saveRun("dag_1", "running", 1);
  await publisher.onTurnStarted(agent, context);
  await publisher.onTurnEnded(agent, context);
  expect(appends).toEqual([]);

  // The grace window closes with the run still unfinished.
  await vi.advanceTimersByTimeAsync(GRACE_MS + 1000);

  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);
  expect(appends[0]?.data.status).toBe("running");
  publisher.dispose();
});

test("a second run gets its own single card, and the finished one is not redrawn", async () => {
  const { agent, saveRun, saveAgentRecord } = await fixture();
  await saveAgentRecord();
  const context = stubContext();
  const publisher = createPublisher();

  await saveRun("dag_1", "completed", 3);
  await publisher.onTurnStarted(agent, context);
  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1"]);

  await saveRun("dag_2", "completed", 3);
  await vi.advanceTimersByTimeAsync(2000);

  expect(appends.map((item) => item.id)).toEqual(["dag-dag_1", "dag-dag_2"]);
  publisher.dispose();
});
