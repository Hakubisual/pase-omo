import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readRows, resolveAgent } from "./runs.js";

/**
 * The chat reader turns the OmO run store into timeline cards. Every failure it
 * swallows looks exactly like "this chat has no DAG" on screen, so an
 * unreadable store, an unreadable agent record, and a timestamp that cannot be
 * placed in time each have a pinned outcome here.
 */

const SESSION = "sess-1";
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-chat-runs-"));
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
  const runsDir = join(cwd, ".omo", "senpi-task", "dag", "runs");
  const saveRun = (file: string, record: Record<string, unknown>): Promise<void> =>
    write(
      join(runsDir, `${file}.json`),
      JSON.stringify({
        schemaVersion: 1,
        parentSessionId: SESSION,
        status: "running",
        updatedAt: "2026-09-15T00:00:00.000Z",
        nodes: [{ id: "n1", label: "node", state: "running" }],
        ...record,
      }),
    );
  const agentRecord = join(paseoHome, "agents", "group", "agent-1.json");
  return { cwd, write, runsDir, saveRun, agentRecord };
}

test("a run file that cannot be parsed is a visible error, not an empty chat", async () => {
  const { cwd, write, runsDir } = await fixture();
  const file = join(runsDir, "dag_torn.json");
  await write(file, '{"schemaVersion":1,"runId":"dag_torn"');

  await expect(readRows(cwd, SESSION, 0)).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD", path: file });
});

test("a workspace that has never written a run reads as no runs", async () => {
  const { cwd } = await fixture();

  await expect(readRows(cwd, SESSION, 0)).resolves.toEqual([]);
});

test("a run whose timestamp cannot be read stays out of the lookback window", async () => {
  const { cwd, saveRun } = await fixture();
  await saveRun("bad", { runId: "dag_bad", updatedAt: "last tuesday" });
  await saveRun("good", { runId: "dag_good" });

  const rows = await readRows(cwd, SESSION, Date.parse("2026-09-01T00:00:00.000Z"));

  expect(rows.map((row) => row.runId)).toEqual(["dag_good"]);
});

test("runs that share a timestamp keep one order, whatever the directory returns", async () => {
  const { cwd, saveRun } = await fixture();
  // File names sort the other way round, so directory order cannot be what
  // decides the result.
  await saveRun("aaa", { runId: "dag_z" });
  await saveRun("zzz", { runId: "dag_a" });

  const rows = await readRows(cwd, SESSION, 0);

  expect(rows.map((row) => row.runId)).toEqual(["dag_a", "dag_z"]);
});

test("a run's dependency links reach the card as edges", async () => {
  const { cwd, saveRun } = await fixture();
  await saveRun("linked", {
    runId: "dag_linked",
    nodes: [
      { id: "plan", label: "plan", state: "completed" },
      { id: "build", label: "build", state: "running", dependsOn: ["plan"] },
      { id: "ship", label: "ship", state: "pending", dependsOn: ["build", "plan"] },
    ],
  });

  const [row] = await readRows(cwd, SESSION, 0);

  expect(row?.edges).toEqual([
    { from: "plan", to: "build" },
    { from: "build", to: "ship" },
    { from: "plan", to: "ship" },
  ]);
});

test("a link to a node that truncation dropped never reaches the card", async () => {
  const { cwd, saveRun } = await fixture();
  // The card keeps the first 60 nodes, so the 61st and every link into it have
  // to disappear together: an edge to a node the card cannot draw would point
  // an arrow at empty canvas.
  const nodes = Array.from({ length: 61 }, (_, index) => ({
    id: `n${index + 1}`,
    label: `node ${index + 1}`,
    state: "pending",
    dependsOn: index === 0 ? [] : ["n1"],
  }));
  await saveRun("big", { runId: "dag_big", nodes });

  const [row] = await readRows(cwd, SESSION, 0);

  expect(row?.truncated).toBe(true);
  expect(row?.edges).toHaveLength(59);
  expect(row?.edges.some((edge) => edge.to === "n61")).toBe(false);
});

test("an agent record that cannot be parsed is a visible error, not an unknown agent", async () => {
  const { write, agentRecord } = await fixture();
  await write(agentRecord, "{ broken");

  await expect(resolveAgent("agent-1")).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD", path: agentRecord });
});

test("a daemon that has written no agent records resolves to nothing", async () => {
  await fixture();

  await expect(resolveAgent("agent-1")).resolves.toEqual({ cwd: null, sessionId: null });
});
