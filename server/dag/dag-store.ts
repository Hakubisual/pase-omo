import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { DagRun, DagSession, DagStatus, DagTask } from "../../shared/dag.js";
import { readSessionHeaders, sameCwd, type SessionHeader, sessionsDir } from "../provider/omo-store.js";
import { taskStateDir as resolveTaskStateDir } from "../task-state.js";

/**
 * Error codes the DAG RPCs expose. Corrupt source data must surface as a
 * visible failure rather than an empty success, otherwise a torn store looks
 * identical to a workspace that simply has no runs.
 */
export function invalidRecord(detail: string, source?: { path?: string; cause?: unknown }): Error {
  return Object.assign(new Error(`Cannot read OmO record: ${detail}`), {
    code: "PASEO_INVALID_RECORD",
    ...(source?.path === undefined ? {} : { path: source.path }),
    ...(source?.cause === undefined ? {} : { cause: source.cause }),
  });
}

function sessionNotFound(): Error {
  return Object.assign(new Error("No matching OmO session for this workspace"), {
    code: "PASEO_SESSION_NOT_FOUND",
  });
}

type Json = Record<string, unknown>;

const TASK_ID = /^st_[A-Za-z0-9_-]{1,253}$/;
const STATUSES = new Set<DagStatus>([
  "pending",
  "blocked",
  "scheduled",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
const TERMINAL = new Set(["completed", "error", "cancelled", "interrupted", "lost", "failed"]);

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Control characters and bidi overrides never reach the UI. */
export const clean = (value: unknown): string =>
  stripVTControlCharacters(String(value ?? "")).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");

function text(value: unknown, limit = 2000): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return clean(value).slice(0, limit);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

const newest = (values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? "";

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/**
 * Project one OmO subagent task record onto the DAG task shape.
 *
 * Only the latest assistant line is exposed as progress; prompts, transcripts,
 * spawn specs and final responses are never retained.
 */
export function normalizeTask(raw: unknown): DagTask | undefined {
  const record = object(raw);
  if (!record || typeof record.task_id !== "string" || !TASK_ID.test(record.task_id)) return undefined;
  const live = object(record.live_progress);
  const stats = object(record.run_stats);
  const tool = text(live?.current_tool, 128);
  const line = text(live?.last_assistant_line, 512);
  const progress = [tool ? `[${tool}]` : undefined, line].filter(Boolean).join(" ");
  const status = text(record.status, 64);
  const terminal = status !== undefined && TERMINAL.has(status);
  const task: DagTask = {
    id: record.task_id,
    ...pick("description", text(record.description) ?? text(record.task_summary) ?? text(record.name)),
    ...pick("agent", text(record.agent_type, 128) ?? text(record.category, 128)),
    ...pick("model", text(object(record.resolved_model)?.display, 256) ?? text(record.model, 256)),
    ...pick("status", status),
    ...pick("startedAt", iso(live?.started_at) ?? iso(record.created_at)),
    ...pick("completedAt", iso(record.terminal_at) ?? (terminal ? iso(record.updated_at) : undefined)),
    ...pick("progress", terminal ? undefined : (text(progress, 512) ?? text(live?.activity, 512))),
    ...pick("turns", count(live?.turns) ?? count(stats?.turns)),
    ...pick("toolCalls", count(live?.tool_calls) ?? count(stats?.tool_calls)),
  };
  return task;
}

function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Checkpoints use camelCase; the RPC projection uses snake_case. Accept both. */
export function normalizeRun(raw: unknown): DagRun | undefined {
  const record = object(raw);
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.edges)) return undefined;
  const id = record.run_id ?? record.runId;
  const status = record.status;
  if (typeof id !== "string" || typeof status !== "string" || !STATUSES.has(status as DagStatus)) return undefined;

  const ids = new Set<string>();
  const nodes: DagRun["nodes"] = [];
  for (const entry of record.nodes) {
    const node = object(entry);
    if (!node || typeof node.id !== "string" || ids.has(node.id)) return undefined;
    const state = node.state;
    if (typeof state !== "string" || !STATUSES.has(state as DagStatus)) return undefined;
    ids.add(node.id);
    const taskId = node.task_id ?? node.taskId;
    nodes.push({
      id: node.id,
      label: clean(node.label ?? node.id),
      state: state as DagStatus,
      attempt: count(node.attempt) ?? 0,
      ...(typeof taskId === "string" ? { taskId } : {}),
      error: clean(object(node.last_error)?.message ?? object(node.error)?.message ?? ""),
    });
  }

  const edges: DagRun["edges"] = [];
  const seen = new Set<string>();
  for (const entry of record.edges) {
    const edge = object(entry);
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") return undefined;
    if (!ids.has(edge.from) || !ids.has(edge.to)) return undefined;
    const key = `${edge.from}\u0000${edge.to}`;
    if (!seen.has(key)) edges.push({ from: edge.from, to: edge.to });
    seen.add(key);
  }

  return {
    id,
    name: clean(record.name ?? record.run_key ?? record.runKey ?? id),
    status: status as DagStatus,
    createdAt: String(record.created_at ?? record.createdAt ?? ""),
    updatedAt: String(record.updated_at ?? record.updatedAt ?? ""),
    nodes,
    edges,
  };
}

/** Topological rows of a run, used by the client to lay the graph out. */
export function runLayers(run: DagRun): DagRun["nodes"][] {
  const remaining = new Set(run.nodes.map((node) => node.id));
  const done = new Set<string>();
  const rows: DagRun["nodes"][] = [];
  while (remaining.size > 0) {
    const row = run.nodes.filter(
      (node) => remaining.has(node.id) && run.edges.every((edge) => edge.to !== node.id || done.has(edge.from)),
    );
    if (row.length === 0) return [run.nodes];
    rows.push(row);
    for (const node of row) {
      remaining.delete(node.id);
      done.add(node.id);
    }
  }
  return rows;
}

export interface DagStoreOptions {
  cwd: string;
  taskStateDir?: string;
  sessionsDir?: string;
}

function resolveOptions(options: DagStoreOptions) {
  if (!nonempty(options.cwd)) throw new TypeError("OmO DAG store requires cwd");
  const cwd = resolve(options.cwd);
  return {
    cwd,
    taskStateDir: options.taskStateDir ? resolve(options.taskStateDir) : resolveTaskStateDir(cwd),
    sessionsDir: resolve(options.sessionsDir ?? sessionsDir()),
  };
}

interface TaskRecord {
  raw: Json;
}

async function readRecords(directory: string): Promise<TaskRecord[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = join(directory, name);
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          // Records are written by atomic rename, so a reader never observes a
          // half-written file: it sees the previous one or nothing. A file that
          // disappeared between the listing and the read is therefore the only
          // benign failure. Anything else — a permission error, an I/O error —
          // is real and must not be reported as "this workspace has no runs".
          if ((error as { code?: string }).code === "ENOENT") return undefined;
          throw invalidRecord(name, { path: file, cause: error });
        }
        let raw: unknown;
        try {
          raw = JSON.parse(text) as unknown;
        } catch (error) {
          throw invalidRecord(name, { path: file, cause: error });
        }
        const value = object(raw);
        if (!value) throw invalidRecord(`${name} is not a record`, { path: file });
        return { raw: value };
      }),
  );
  return records.filter((record): record is TaskRecord => record !== undefined);
}

interface Catalog {
  cwd: string;
  sessions: Map<string, { id: string; cwd: string; createdAt: string; updatedAt: string; name?: string; file?: string }>;
  children: Set<string>;
  tasks: TaskRecord[];
  runs: TaskRecord[];
}

async function readCatalog(options: ReturnType<typeof resolveOptions>): Promise<Catalog> {
  const [headers, tasks, runs] = await Promise.all([
    readSessionHeaders(options.sessionsDir),
    readRecords(join(options.taskStateDir, "tasks")),
    readRecords(join(options.taskStateDir, "dag", "runs")),
  ]);

  // A record that claims to be ours — it names a parent session, and a run also
  // declares schemaVersion 1 — but fails to normalise is corrupt, not foreign.
  // Report it rather than quietly dropping the run out of the graph.
  const validTasks = tasks.filter(({ raw }) => {
    if (!nonempty(raw.parent_session_id)) return false;
    if (normalizeTask(raw) === undefined) throw invalidRecord(`task ${String(raw.task_id ?? "<unknown>")}`);
    return true;
  });
  const validRuns = runs.filter(({ raw }) => {
    if (raw.schemaVersion !== 1 || !nonempty(raw.parentSessionId)) return false;
    if (normalizeRun(raw) === undefined) throw invalidRecord(`run ${String(raw.runId ?? "<unknown>")}`);
    return true;
  });

  const sessions: Catalog["sessions"] = new Map();
  const children = new Set<string>();
  for (const header of headers as SessionHeader[]) {
    const existing = sessions.get(header.id);
    if (!existing || existing.updatedAt < header.updatedAt) {
      sessions.set(header.id, {
        id: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        updatedAt: header.updatedAt,
        ...(header.name ? { name: header.name } : {}),
        file: header.file,
      });
    }
    if (header.child) children.add(header.id);
  }
  for (const { raw } of validTasks) {
    if (nonempty(raw.child_session_id)) children.add(raw.child_session_id);
    if (nonempty(raw.root_session_id) && raw.root_session_id !== raw.parent_session_id) {
      children.add(String(raw.parent_session_id));
    }
    if (typeof raw.depth === "number" && raw.depth > 1) children.add(String(raw.parent_session_id));
  }

  const fallback = (id: unknown, cwd: unknown, createdAt: unknown, updatedAt: unknown): void => {
    if (!nonempty(id) || !nonempty(cwd)) return;
    const existing = sessions.get(id);
    if (existing?.file) return;
    const created = iso(createdAt) ?? "";
    sessions.set(id, {
      id,
      cwd: resolve(cwd),
      createdAt: [existing?.createdAt, created].filter(Boolean).sort()[0] ?? "",
      updatedAt: newest([existing?.updatedAt, iso(updatedAt), created]),
    });
  };
  for (const { raw } of validTasks) {
    const root = nonempty(raw.root_session_id) ? raw.root_session_id : raw.parent_session_id;
    if (nonempty(root) && !children.has(root)) fallback(root, object(raw.spawn_spec)?.cwd, raw.created_at, raw.updated_at);
  }
  for (const { raw } of validRuns) {
    const root = nonempty(raw.rootSessionId) ? raw.rootSessionId : raw.parentSessionId;
    if (nonempty(root) && root !== raw.parentSessionId) children.add(String(raw.parentSessionId));
    if (nonempty(root) && !children.has(root)) fallback(root, raw.cwd, raw.createdAt, raw.updatedAt);
  }

  return { cwd: options.cwd, sessions, children, tasks: validTasks, runs: validRuns };
}

interface TaskEntry {
  task: DagTask;
  parentSessionId: string;
  updatedAt?: string;
  childSessionId?: string;
}

/**
 * Merge every task record for one session, then select its DAG.
 *
 * A task owns a child session rather than a DAG successor, so only explicit
 * `parentTaskId` links and a parent's own child session establish an edge.
 */
function project(catalog: Catalog, sessionId: string): { tasks: DagTask[]; runs: DagRun[] } {
  const entries = new Map<string, TaskEntry>();
  for (const { raw } of catalog.tasks) {
    const task = normalizeTask(raw);
    const parentSessionId = raw.parent_session_id;
    if (!task || !nonempty(parentSessionId)) continue;
    const previous = entries.get(task.id);
    if (previous && previous.parentSessionId !== parentSessionId) continue;
    const updatedAt = iso(raw.updated_at);
    if (previous?.updatedAt && updatedAt && updatedAt < previous.updatedAt) continue;
    const merged: DagTask = { ...previous?.task, ...task };
    if (merged.status !== undefined && TERMINAL.has(merged.status)) {
      delete merged.progress;
      if (!iso(raw.terminal_at) && previous?.task.completedAt) merged.completedAt = previous.task.completedAt;
    } else if (task.status !== undefined) {
      delete merged.completedAt;
    }
    entries.set(task.id, {
      ...previous,
      task: merged,
      parentSessionId,
      ...(updatedAt ? { updatedAt } : {}),
      ...(nonempty(raw.child_session_id) ? { childSessionId: raw.child_session_id } : {}),
    });
  }

  const selected = new Map<string, DagTask>();
  for (const [id, entry] of entries) {
    if (entry.parentSessionId === sessionId && entry.task.parentTaskId === undefined) selected.set(id, { ...entry.task });
  }
  // Walk the tree to its full depth. A task linked here becomes a parent for the
  // next round, so a grandchild reached through a child session is kept; a single
  // pass over a snapshot of the roots would drop everything below depth one.
  const pending = [...selected.keys()];
  while (pending.length > 0) {
    const parentId = pending.shift() as string;
    const parent = entries.get(parentId);
    if (!parent) continue;
    for (const [id, entry] of entries) {
      if (selected.has(id)) continue;
      const linked =
        entry.task.parentTaskId === parentId ||
        (parent.childSessionId !== undefined && entry.parentSessionId === parent.childSessionId);
      if (!linked) continue;
      selected.set(id, { ...entry.task, parentTaskId: parentId });
      pending.push(id);
    }
  }

  const runs = catalog.runs
    .filter(({ raw }) => raw.parentSessionId === sessionId)
    .map(({ raw }) => normalizeRun(raw))
    .filter((run): run is DagRun => run !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  return { tasks: [...selected.values()], runs };
}

/** Top-level OmO sessions rooted at this workspace directory. */
export async function listDagSessions(options: DagStoreOptions): Promise<DagSession[]> {
  const resolved = resolveOptions(options);
  const catalog = await readCatalog(resolved);
  const sessions: DagSession[] = [];
  for (const session of catalog.sessions.values()) {
    if (!sameCwd(session.cwd, catalog.cwd) || catalog.children.has(session.id)) continue;
    const { tasks, runs } = project(catalog, session.id);
    const ids = new Set(tasks.map((task) => task.id));
    sessions.push({
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: newest([
        session.updatedAt,
        ...catalog.tasks.filter(({ raw }) => ids.has(String(raw.task_id))).map(({ raw }) => iso(raw.updated_at)),
        ...runs.map((run) => iso(run.updatedAt)),
      ]),
      taskCount: tasks.length,
      runCount: runs.length,
      runningCount:
        tasks.filter((task) => task.status === "running").length +
        runs.filter((run) => run.status === "running").length,
      ...(session.name ? { title: session.name } : {}),
    });
  }
  return sessions.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

export async function getDagSnapshot(
  options: DagStoreOptions & { sessionId: string },
): Promise<{ sessionId: string; tasks: DagTask[]; runs: DagRun[] }> {
  const resolved = resolveOptions(options);
  const catalog = await readCatalog(resolved);
  const selected = catalog.sessions.get(options.sessionId);
  if (!selected || !sameCwd(selected.cwd, resolved.cwd)) {
    throw sessionNotFound();
  }
  return { sessionId: selected.id, ...project(catalog, selected.id) };
}
