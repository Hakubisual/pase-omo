import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

import { dagRunsDir, taskStateDir } from "../task-state";

/**
 * Background work that is not a `task()` record: workpool items and DAG runs.
 * Their files are read here and projected as child sessions the same way
 * `taskChildEvents` projects task records.
 */

export type OpenWork = {
  kind: "workpool" | "dag";
  id: string;
  title: string;
  description: string;
};

export type WatchChild = { id: string; title: string; description: string };
export type WatchChildState = { opened: boolean; closed: boolean };

const WORKPOOL_FILE = /^wp_[0-9a-f]{32}\.json$/;
const DAG_TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "error",
  "cancelled",
  "interrupted",
  "lost",
  "failed",
]);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `undefined` when the directory is missing, `"unreadable"` on any other failure. */
async function readJsonFiles(dir: string, accept: (name: string) => boolean): Promise<unknown[] | "unreadable"> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : "unreadable";
  }
  const parsed: unknown[] = [];
  for (const name of names.filter(accept)) {
    try {
      parsed.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      return "unreadable";
    }
  }
  return parsed;
}

function poolItems(pool: Json, omoSessionId: string): OpenWork[] {
  if (pool.parent_session_id !== omoSessionId && pool.root_session_id !== omoSessionId) return [];
  if (pool.status === "cancelled") return [];
  const poolId = text(pool.pool_id) ?? "";
  const rawItems = pool.items;
  const items = Array.isArray(rawItems) ? rawItems : Object.values(asObject(rawItems) ?? {});
  const open: OpenWork[] = [];
  for (const raw of items) {
    const item = asObject(raw);
    if (item === undefined || (item.status !== "queued" && item.status !== "assigned")) continue;
    const taskId = text(asObject(item.binding)?.task_id);
    if (taskId?.startsWith("st_")) continue;
    const key = text(item.key) ?? "";
    open.push({
      kind: "workpool",
      id: text(item.item_id) ?? `wp-${poolId}-${key}`,
      title: key,
      description: text(pool.name) ?? poolId,
    });
  }
  return open;
}

function dagRun(run: Json, omoSessionId: string): OpenWork[] {
  if (run.parentSessionId !== omoSessionId) return [];
  if (typeof run.status === "string" && DAG_TERMINAL.has(run.status)) return [];
  const runId = text(run.runId);
  if (runId === undefined) return [];
  const label = text(run.name) ?? runId;
  return [{ kind: "dag", id: runId, title: label, description: `Workflow ${label}` }];
}

/** Open workpool items and non-terminal DAG runs owned by this OmO session. */
export async function readOpenWork(
  cwd: string,
  omoSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenWork[] | "unreadable"> {
  const pools = await readJsonFiles(join(taskStateDir(cwd, env), "workpools"), (n) => WORKPOOL_FILE.test(n));
  const runs = await readJsonFiles(dagRunsDir(cwd, env), (n) => n.endsWith(".json"));
  if (pools === "unreadable" || runs === "unreadable") return "unreadable";
  const work: OpenWork[] = [];
  for (const pool of pools) {
    const obj = asObject(pool);
    if (obj !== undefined) work.push(...poolItems(obj, omoSessionId));
  }
  for (const run of runs) {
    const obj = asObject(run);
    if (obj !== undefined) work.push(...dagRun(obj, omoSessionId));
  }
  return work;
}

export function projectWatchChildren(input: {
  live: readonly WatchChild[];
  parentSessionId: string;
  cwd: string;
  previous: ReadonlyMap<string, WatchChildState>;
}): { events: ProviderEvent[]; state: Map<string, WatchChildState> } {
  const { live, parentSessionId, cwd, previous } = input;
  const events: ProviderEvent[] = [];
  const state = new Map<string, WatchChildState>();
  const liveIds = new Set<string>();

  for (const child of live) {
    if (child.id.startsWith("st_")) continue;
    liveIds.add(child.id);
    const prior = previous.get(child.id);
    if (prior?.opened === true && !prior.closed) {
      state.set(child.id, { ...prior });
      continue;
    }
    events.push(
      {
        type: "session.opened",
        sessionId: child.id,
        parentSessionId,
        capabilities: [],
        restoration: "core",
        title: child.title,
        description: child.description,
        cwd,
      },
      {
        type: "timeline.item",
        sessionId: child.id,
        item: { type: "assistant_message", id: `${child.id}-summary`, text: child.description },
      },
      { type: "session.turn", sessionId: child.id, turnId: `${child.id}-run`, state: "started" },
    );
    state.set(child.id, { opened: true, closed: false });
  }

  for (const [id, prior] of previous) {
    if (liveIds.has(id)) continue;
    if (!prior.opened || prior.closed) {
      state.set(id, { ...prior });
      continue;
    }
    events.push(
      {
        type: "timeline.item",
        sessionId: id,
        item: { type: "assistant_message", id: `${id}-result`, text: "Finished" },
      },
      { type: "session.turn", sessionId: id, turnId: `${id}-run`, state: "completed" },
      { type: "session.closed", sessionId: id },
    );
    state.set(id, { opened: true, closed: true });
  }
  return { events, state };
}

/**
 * Background bash sessions persisted beside the session file.
 *
 * Their wake event is published on the in-process bus only, so an RPC client
 * cannot see it. The session file lives directly in the session directory, and
 * the terminal sidecar is `extensions/terminal/<encoded session id>.json`.
 * A missing file means none. A file that cannot be parsed is not treated as idle.
 */
export async function readBackgroundSessions(
  sessionFile: string,
  sessionId: string,
): Promise<{ sessions: WatchChild[]; count: number } | "unreadable"> {
  const path = join(dirname(sessionFile), "extensions", "terminal", `${encodeURIComponent(sessionId)}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { sessions: [], count: 0 } : "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  const listed = asObject(parsed)?.backgroundSessions;
  if (!Array.isArray(listed)) return "unreadable";
  const sessions: WatchChild[] = [];
  for (const rawEntry of listed) {
    const entry = asObject(rawEntry);
    const id = text(entry?.id);
    if (!id || id.startsWith("st_")) continue;
    const command = text(entry?.command);
    sessions.push({
      id,
      title: command ?? id,
      description: command ? `Background bash: ${command}` : `Background bash ${id}`,
    });
  }
  return { sessions, count: listed.length };
}
