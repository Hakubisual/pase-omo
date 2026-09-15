import { join, resolve } from "node:path";

/**
 * The OmO task-state tree has two readers inside this plugin: the snapshot RPCs
 * (`server/dag`) and the timeline publisher (`server/chat`). They were separate
 * plugins before the merge and disagreed — the snapshot side honoured
 * `PASEO_OMO_TASK_STATE_DIR` while the publisher hardcoded the workspace path,
 * so with the override set one reader saw runs the other could not. Both now
 * resolve the directory here.
 */

/** An override is only an override when it names something. */
function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Root of the task-state tree for a workspace.
 *
 * `PASEO_OMO_TASK_STATE_DIR` wins; `OMO_HERDR_DAG_TASK_STATE_DIR` is the older
 * name kept working for deployments that already set it. An empty or
 * whitespace-only value is ignored rather than resolved, which would otherwise
 * silently redirect the whole store to the process working directory.
 */
export function taskStateDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = named(env.PASEO_OMO_TASK_STATE_DIR) ?? named(env.OMO_HERDR_DAG_TASK_STATE_DIR);
  return resolve(override ?? join(resolve(cwd), ".omo", "senpi-task"));
}

/** Directory holding one JSON file per DAG run. */
export function dagRunsDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(taskStateDir(cwd, env), "dag", "runs");
}
