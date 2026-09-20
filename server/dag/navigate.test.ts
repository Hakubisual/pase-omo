import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { locateDag } from "./dag.js";
import { locateDagRpc } from "../../shared/navigate.js";
import { sdkContext } from "../chat/sdk-context.test-support.js";

const unusedContext = sdkContext("unused").context;

/**
 * "Open in OmO DAG" has to land on the session that owns the work. Ownership is
 * recorded — a run names its parent session, a task names the session it spawned
 * — so navigation walks those links instead of guessing from a list whose newest
 * entry is almost never the right destination.
 */

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-dag-locate-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const taskDir = join(cwd, ".omo", "senpi-task");
  vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("OMO_HERDR_DAG_TASK_STATE_DIR", "");
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", "");

  async function save(file: string, value: unknown) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  async function header(id: string, directory = cwd, extra: Record<string, unknown> = {}) {
    const file = join(agentDir, "sessions", "bucket", `${id}.jsonl`);
    await save(file, { type: "session", id, cwd: directory, timestamp, ...extra });
    await writeFile(file, `${await readFile(file, "utf8")}\n`);
    return file;
  }
  const task = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
    save(join(taskDir, "tasks", `${id}.json`), {
      task_id: id,
      parent_session_id: parent,
      status: "running",
      created_at: timestamp,
      description: id,
      ...extra,
    });
  const run = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
    save(join(taskDir, "dag", "runs", `${id}.json`), {
      schemaVersion: 1,
      runId: id,
      parentSessionId: parent,
      status: "running",
      createdAt: timestamp,
      nodes: [{ id: "a", state: "running", taskId: "st_root" }],
      edges: [],
      ...extra,
    });
  return { root, cwd, header, task, run };
}

test("the RPC keeps its machine-consumed name and rejects empty identifiers", () => {
  expect(locateDagRpc.name).toBe("dag.locate");
  expect(locateDagRpc.input.safeParse({ cwd: " " }).success).toBe(false);
  expect(locateDagRpc.input.safeParse({ cwd: "project", sessionId: "" }).success).toBe(false);
  expect(locateDagRpc.input.safeParse({ cwd: "project" }).success).toBe(true);
});

test("a child session resolves to the top-level session that owns it", async () => {
  const { cwd, header, task, run } = await fixture();
  await header("parent");
  await header("child", cwd, { parentSession: "parent.jsonl" });
  await task("st_root", "parent", { child_session_id: "child" });
  await task("st_child", "child");
  await run("dag_parent", "parent");

  // Navigating from the child session, which the dashboard never lists.
  await expect(locateDag({ cwd, sessionId: "child" }, unusedContext)).resolves.toEqual({
    destination: { cwd, sessionId: "parent" },
    });

  // Navigating from a run and from a task, without naming a session at all.
  await expect(locateDag({ cwd, runId: "dag_parent" }, unusedContext)).resolves.toEqual({
    destination: { cwd, sessionId: "parent", runId: "dag_parent" },
  });
  await expect(locateDag({ cwd, taskId: "st_child" }, unusedContext)).resolves.toEqual({
    destination: { cwd, sessionId: "parent", taskId: "st_child" },
  });
});

test("a destination that no longer exists is reported instead of opening another session", async () => {
  const { cwd, header, task, run } = await fixture();
  await header("parent");
  await task("st_root", "parent");
  await run("dag_parent", "parent");

  const unknownSession = await locateDag({ cwd, sessionId: "vanished" }, unusedContext);
  expect(unknownSession.destination).toBeNull();
  expect(unknownSession.reason).toContain("vanished");

  const unknownRun = await locateDag({ cwd, sessionId: "parent", runId: "dag_gone" }, unusedContext);
  expect(unknownRun.destination).toEqual({ cwd, sessionId: "parent" });
  expect(unknownRun.reason).toContain("dag_gone");

  const nothingKnown = await locateDag({ cwd, runId: "dag_gone" }, unusedContext);
  expect(nothingKnown.destination).toBeNull();
  expect(nothingKnown.reason).toBeTruthy();
});

test("agent navigation fetches its SDK identity without agent files", async () => {
  const { cwd, header, run } = await fixture();
  const sessionFile = await header("parent");
  await run("dag_parent", "parent");
  const sdk = sdkContext(cwd, "parent");
  sdk.snapshot.runtimeInfo = { provider: "omo", sessionId: `omo ${JSON.stringify({ data: { sessionFile } })}` };
  await expect(locateDag({ agentId: "agent-1" }, sdk.context)).resolves.toMatchObject({
    destination: { cwd, sessionId: "parent" },
  });
  expect(sdk.ref).toHaveBeenCalledWith("agent-1");
  expect(sdk.refresh).toHaveBeenCalledTimes(1);
});

test("missing SDK identity does not select another chat in the same workspace", async () => {
  const { cwd, header, run } = await fixture();
  await header("other");
  await run("dag_other", "other");
  const sdk = sdkContext(cwd, null);
  const result = await locateDag({ agentId: "agent-1" }, sdk.context);
  expect(result.destination).toBeNull();
});

test("navigation propagates SDK failures", async () => {
  const sdk = sdkContext("E:/project");
  const error = new Error("SDK unavailable");
  sdk.refresh.mockRejectedValue(error);
  await expect(locateDag({ agentId: "agent-1" }, sdk.context)).rejects.toBe(error);
});

test("an agent with no recorded workspace reports that rather than picking one", async () => {
  await fixture();
  const located = await locateDag({ sessionId: "parent" }, unusedContext);
  expect(located.destination).toBeNull();
  expect(located.reason).toContain("워크스페이스");
});
