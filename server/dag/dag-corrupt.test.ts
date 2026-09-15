import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { getSnapshot, listSessions } from "./dag.js";

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-dag-corrupt-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const taskDir = join(cwd, ".omo", "senpi-task");
  vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", "");
  vi.stubEnv("OMO_HERDR_DAG_TASK_STATE_DIR", "");

  const save = async (file: string, body: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  await save(
    join(agentDir, "sessions", "bucket", "parent.jsonl"),
    JSON.stringify({ type: "session", id: "parent", cwd, timestamp }),
  );
  return { cwd, taskDir, save };
}

/**
 * The vendored backend this merge replaced ignored only a disappearing file and
 * raised PASEO_INVALID_RECORD, carrying the offending path, for anything it
 * could not read or parse. Swallowing those makes a corrupt or unreadable store
 * indistinguishable from a workspace that simply has no runs.
 */
test("a run file that is not parseable JSON is a visible error, not an empty success", async () => {
  const { cwd, taskDir, save } = await fixture();
  await save(join(taskDir, "dag", "runs", "dag_torn.json"), '{"schemaVersion":1,"runId":"dag_torn"');

  await expect(listSessions({ cwd })).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD" });
  await expect(getSnapshot({ cwd, sessionId: "parent" })).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD" });
});

test("a task file holding a non-object JSON value is a visible error", async () => {
  const { cwd, taskDir, save } = await fixture();
  await save(join(taskDir, "tasks", "st_array.json"), '["not", "a", "record"]');

  await expect(listSessions({ cwd })).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD" });
});

test("the invalid-record error names the file it could not read", async () => {
  const { cwd, taskDir, save } = await fixture();
  const file = join(taskDir, "dag", "runs", "dag_named.json");
  await save(file, "{ broken");

  await expect(listSessions({ cwd })).rejects.toMatchObject({ path: file });
});

test("an absent store is still a success: the session lists with zero counts", async () => {
  const { cwd } = await fixture();
  await expect(listSessions({ cwd })).resolves.toMatchObject({
    sessions: [expect.objectContaining({ id: "parent", taskCount: 0, runCount: 0 })],
  });
});
