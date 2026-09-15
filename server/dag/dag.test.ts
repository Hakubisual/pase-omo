import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { getSnapshot, listSessions } from "./dag.js";
import { getSnapshotRpc, listSessionsRpc } from "../../shared/dag.js";

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-dag-rpc-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const taskDir = join(cwd, ".omo", "senpi-task");
  vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("OMO_HERDR_DAG_TASK_STATE_DIR", "");
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", "");
  vi.stubEnv("OMO_HERDR_DAG_STATE_DIR", join(root, "must-not-be-created"));
  async function save(file: string, value: unknown) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  async function header(id: string, directory = cwd, extra: Record<string, unknown> = {}) {
    const file = join(agentDir, "sessions", "bucket", `${id}.jsonl`);
    await save(file, { type: "session", id, cwd: directory, timestamp, ...extra });
    await writeFile(file, (await readFile(file, "utf8")) + "\nPRIVATE_TRANSCRIPT_NOT_JSON\n");
  }
  const task = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
    save(join(taskDir, "tasks", `${id}.json`), {
      task_id: id, parent_session_id: parent, status: "running", created_at: timestamp,
      description: id, spawn_spec: { cwd, prompt: "PRIVATE_PROMPT" }, ...extra,
    });
  const run = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
    save(join(taskDir, "dag", "runs", `${id}.json`), {
      schemaVersion: 1, runId: id, parentSessionId: parent, status: "running", createdAt: timestamp,
      nodes: [{ id: "a", state: "running", taskId: "st_root" }, { id: "b", state: "pending" }],
      edges: [{ from: "a", to: "b" }], prompt: "PRIVATE_RUN_PROMPT", ...extra,
    });
  return { root, cwd, header, task, run };
}

async function bytes(root: string): Promise<[string, string][]> {
  const result: [string, string][] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await bytes(path));
    else result.push([path, await readFile(path, "utf8")]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test("RPC contracts retain machine-consumed names and reject empty selections", () => {
  expect(listSessionsRpc.name).toBe("dag.sessions");
  expect(getSnapshotRpc.name).toBe("dag.snapshot");
  expect(listSessionsRpc.input.safeParse({ cwd: " " }).success).toBe(false);
  expect(getSnapshotRpc.input.safeParse({ cwd: "project" }).success).toBe(false);
  expect(getSnapshotRpc.input.safeParse({ cwd: "project", sessionId: "" }).success).toBe(false);
});

test("empty sessions succeed, missing and foreign sessions reject, and missing stores stay absent", async () => {
  const { root, cwd, header } = await fixture();
  expect(await listSessions({ cwd })).toEqual({ sessions: [] });
  await header("empty");
  await header("foreign", join(root, "other"));
  expect(await getSnapshot({ cwd, sessionId: "empty" })).toEqual({ sessionId: "empty", tasks: [], runs: [] });
  for (const sessionId of ["missing", "foreign", "../empty"]) {
    await expect(getSnapshot({ cwd, sessionId })).rejects.toMatchObject({ code: "PASEO_SESSION_NOT_FOUND" });
  }
  await expect(readdir(cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("real handlers return only the selected cwd's own-session tree and normalized checkpoint", async () => {
  const { root, cwd, header, task, run } = await fixture();
  await header("parent");
  await header("child", cwd, { parentSession: "parent.jsonl" });
  await header("foreign", join(root, "other"));
  await task("st_root", "parent", { child_session_id: "child" });
  await task("st_child", "child", { child_session_id: "grand" });
  await task("st_grand", "grand");
  await task("st_ordinary", "parent");
  await task("st_foreign", "foreign");
  await task("st_unlinked", "unlinked", { root_session_id: "parent", depth: 2 });
  await run("dag_parent", "parent");
  await run("dag_foreign", "foreign");
  const before = await bytes(root);
  const sessions = await listSessions({ cwd });
  expect(sessions.sessions).toEqual([expect.objectContaining({ id: "parent", cwd, taskCount: 4, runCount: 1 })]);
  const snapshot = await getSnapshot({ cwd, sessionId: "parent" });
  expect(snapshot.sessionId).toBe("parent");
  expect(snapshot.tasks.map(task => task.id).sort()).toEqual(["st_child", "st_grand", "st_ordinary", "st_root"]);
  expect(snapshot.tasks.find(task => task.id === "st_child")?.parentTaskId).toBe("st_root");
  expect(snapshot.tasks.find(task => task.id === "st_grand")?.parentTaskId).toBe("st_child");
  expect(snapshot.tasks.find(task => task.id === "st_ordinary")?.parentTaskId).toBeUndefined();
  expect(snapshot.runs).toEqual([{
    id: "dag_parent", name: "dag_parent", status: "running", createdAt: timestamp, updatedAt: "",
    nodes: [
      { id: "a", label: "a", state: "running", attempt: 0, taskId: "st_root", error: "" },
      { id: "b", label: "b", state: "pending", attempt: 0, taskId: undefined, error: "" },
    ],
    edges: [{ from: "a", to: "b" }],
  }]);
  expect(JSON.stringify({ sessions, snapshot })).not.toMatch(/PRIVATE_|spawn_spec|parent_session_id/);
  expect(await bytes(root)).toEqual(before);
  expect(await readdir(root)).not.toContain("must-not-be-created");
});

test("malformed source data is a visible RPC error, not an empty success", async () => {
  const { cwd, header, run } = await fixture();
  await header("parent");
  await run("dag_bad", "parent", { nodes: {} });
  await expect(listSessions({ cwd })).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD" });
  await expect(getSnapshot({ cwd, sessionId: "parent" })).rejects.toMatchObject({ code: "PASEO_INVALID_RECORD" });
});
