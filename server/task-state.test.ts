import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dagRunsDir, taskStateDir } from "./task-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The DAG runs tree has two readers: the snapshot RPCs (server/dag) and the
 * timeline publisher (server/chat). Before the merge only the first honoured
 * PASEO_OMO_TASK_STATE_DIR, so with the override set one reader saw runs the
 * other could not.
 */
test("an override redirects the runs directory for every reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  const override = join(root, "elsewhere");

  expect(taskStateDir(cwd, {})).toBe(resolve(join(cwd, ".omo", "senpi-task")));
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(override));
  expect(dagRunsDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(join(override, "dag", "runs")));
});

test("the legacy OMO_HERDR_DAG_TASK_STATE_DIR name still works, but loses to the current one", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");

  expect(taskStateDir(cwd, { OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") })).toBe(resolve(join(root, "legacy")));
  expect(
    taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: join(root, "current"), OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") }),
  ).toBe(resolve(join(root, "current")));
});

test("an empty override is ignored rather than resolving to the process cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: "  " })).toBe(resolve(join(cwd, ".omo", "senpi-task")));
});
