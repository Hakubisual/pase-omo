import type { DagRun, DagSession, DagTask } from "../shared/dag.js";

/**
 * Folder-tree model for browsing OmO DAG runs and sub-agent sessions.
 *
 * Pure functions only: no React, no host imports, no side effects. The
 * component in `folders.tsx` is a shell over this model, the same split the
 * todo card uses (`todo-visual.ts` + `todo-card.tsx`).
 */

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Folder identity is structural, so React keys and the expand-state set stay
 * stable while data streams underneath: sessions and runs are stable ids, and
 * task folders are addressed by their task id within their owning session.
 *
 * All builders take `sessionId: string` so the key space of a scoped tree and
 * an unfiled one can never collide ("" means "no session").
 */
export const folderKey = {
  root: "root",
  session: (sessionId: string): string => `session:${sessionId}`,
  run: (sessionId: string, runId: string): string => `run:${sessionId}:${runId}`,
  task: (sessionId: string, taskId: string): string => `task:${sessionId}:${taskId}`,
} as const;

// ---------------------------------------------------------------------------
// Tree shape
// ---------------------------------------------------------------------------

/**
 * One row the browser draws. Every drawn string and count is precomputed here
 * so the component stays a shell; `depth` is the indentation input, and
 * `sessionId` is the payload `onOpenSession` receives.
 */
export interface FolderNode {
  key: string;
  kind: "root" | "session" | "run" | "task";
  /** Indentation level, 0 at the root row. */
  depth: number;
  label: string;
  /** Live task count beneath this folder (0 for a task leaf). */
  count: number;
  status: string | undefined;
  /** Payload for `onOpenSession`; "" on folders that open nothing. */
  sessionId: string;
  /** The run id when this folder is a run, so a caller can route to a run. */
  runId: string | undefined;
  children: FolderNode[];
}

export interface FolderTree {
  root: FolderNode;
  /** Live task count across the whole tree, recounted from the nodes. */
  count: number;
  /** True when the input has no sessions, runs or tasks at all. */
  empty: boolean;
  /** Every folder key in the tree, for expand-all and visible-row walkers. */
  folderKeys: ReadonlySet<string>;
}

/**
 * Where content came from. `dag.snapshot` returns runs and tasks for one
 * session but neither `DagRun` nor `DagTask` carries the session id, so the
 * caller states which session the content belongs to; content handed over with
 * no (or an unknown) session groups under the explicit 미분류 folder.
 */
export interface FolderScope {
  sessionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Deterministic ordering — mirrors server/dag/dag-store.ts
// ---------------------------------------------------------------------------

const beforeSession = (a: DagSession, b: DagSession): number =>
  b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

const beforeRun = (a: DagRun, b: DagRun): number =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

const taskStamp = (task: DagTask): string => task.startedAt ?? task.completedAt ?? "";

const beforeTask = (a: DagTask, b: DagTask): number =>
  taskStamp(a).localeCompare(taskStamp(b)) || a.id.localeCompare(b.id);

const ROOT_LABEL = "전체";

/** Content that arrived without a session scope groups under this folder. */
const UNFILED_LABEL = "미분류";

const taskLabel = (task: DagTask): string =>
  task.description?.trim() ? task.description : `${task.id.slice(0, 12)}…`;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type Content = { runs: DagRun[]; tasks: DagTask[] };

/**
 * Builds the folder forest of one session: run folders (newest first, the
 * store's order) each holding the task chains its nodes claim, then the
 * session-rooted task chains no run claimed.
 */
function sessionFolder(
  session: Pick<DagSession, "id" | "title"> & Partial<Pick<DagSession, "runCount" | "taskCount">>,
  content: Content,
): FolderNode {
  const sessionId = session.id;
  const label =
    sessionId === ""
      ? UNFILED_LABEL
      : session.title?.trim()
        ? session.title
        : `${sessionId.slice(0, 12)}…`;

  const node: FolderNode = {
    key: folderKey.session(sessionId),
    kind: "session",
    depth: 1,
    label,
    count: 0,
    status: undefined,
    sessionId,
    runId: undefined,
    children: [],
  };

  // Runs render newest first, and each run consumes its claimed tasks: a task
  // referenced by several runs is filed under the newest one alone, so every
  // task exists in exactly one folder.
  const taken = new Set<string>();
  for (const run of [...content.runs].sort(beforeRun)) {
    const selection = new Set<string>();
    for (const entry of run.nodes) {
      if (entry.taskId !== undefined && !taken.has(entry.taskId)) selection.add(entry.taskId);
    }
    for (const id of selection) taken.add(id);
    node.children.push({
      key: folderKey.run(sessionId, run.id),
      kind: "run",
      depth: 2,
      label: run.name.trim() ? run.name : run.id,
      count: 0,
      status: run.status,
      sessionId,
      runId: run.id,
      children: buildTaskForest(sessionId, content.tasks, selection),
    });
  }
  const leftover = new Set(content.tasks.filter((task) => !taken.has(task.id)).map((task) => task.id));
  node.children.push(...buildTaskForest(sessionId, content.tasks, leftover));
  // A folder the panel has not loaded yet still knows how much it holds: the
  // session summary is the only honest number before it is opened, and a
  // closed folder claiming 0 reads as "empty" rather than "unopened".
  if (node.count === 0) {
    node.count = (session.runCount ?? 0) + (session.taskCount ?? 0);
  }

  return node;
}

/**
 * Builds the nested folder forest of exactly the tasks in `selected`, following
 * `parentTaskId` chains: a task whose parent is present and selected nests
 * inside it, a task whose parent is absent (or selected by another run) roots
 * the chain. Callers pass a run's claimed ids, or the complement of every
 * run's claim for the session-rooted leftovers, so each task is filed once.
 *
 * A corrupt `parentTaskId` cycle would otherwise recurse forever, so linking
 * refuses an edge that points at the node's own chain ancestor.
 */
function buildTaskForest(sessionId: string, tasks: readonly DagTask[], selected: ReadonlySet<string>): FolderNode[] {
  const byId = new Map<string, DagTask>();
  const nodes = new Map<string, FolderNode>();
  for (const task of [...tasks].sort(beforeTask)) {
    if (!selected.has(task.id) || byId.has(task.id)) continue;
    byId.set(task.id, task);
    nodes.set(task.id, {
      key: folderKey.task(sessionId, task.id),
      kind: "task",
      depth: 0,
      label: taskLabel(task),
      count: 0,
      status: task.status,
      sessionId,
      runId: undefined,
      children: [],
    });
  }

  const parentOf = new Map<string, string | undefined>();
  for (const [id, task] of byId) parentOf.set(id, task.parentTaskId);

  const roots: FolderNode[] = [];
  for (const [id, node] of nodes) {
    const parentId = parentOf.get(id);
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
    if (parent === undefined || parent === node || createsCycle(id, parentId, parentOf)) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const byKey = (a: FolderNode, b: FolderNode): number => a.key.localeCompare(b.key);
  const sortedRoots = [...roots].sort(byKey);
  for (const node of nodes.values()) node.children.sort(byKey);
  return sortedRoots;
}

/** True when `start` reaches `id` by climbing parent links, bounded by size. */
function createsCycle(
  id: string,
  start: string | undefined,
  parentOf: ReadonlyMap<string, string | undefined>,
): boolean {
  let current = start;
  for (let hops = 0; current !== undefined && hops <= parentOf.size; hops += 1) {
    if (current === id) return true;
    current = parentOf.get(current);
  }
  return false;
}

/** One walk: pin depths, collect folder keys, fold live task counts up. */
function finalize(node: FolderNode, depth: number, keys: Set<string>): number {
  node.depth = depth;
  keys.add(node.key);
  let total = node.kind === "task" ? 1 : 0;
  for (const child of node.children) total += finalize(child, depth + 1, keys);
  // A session folder whose contents are not loaded keeps the summary count it
  // was built with: zero would read as "this session is empty" when it only
  // means "not opened yet".
  if (node.kind !== "task" && !(node.kind === "session" && total === 0)) node.count = total;
  return total;
}

/**
 * Builds the whole tree: session folders sorted newest first (the store's
 * `listDagSessions` order), each filed with the runs and tasks of `scope`.
 *
 * The root row is a real folder so the whole tree can collapse; its count is
 * the number of task leaves beneath it.
 */
export function buildFolderTree(
  sessions: readonly DagSession[],
  runs: readonly DagRun[],
  tasks: readonly DagTask[],
  scope: FolderScope = {},
): FolderTree {
  const root: FolderNode = {
    key: folderKey.root,
    kind: "root",
    depth: 0,
    label: ROOT_LABEL,
    count: 0,
    status: undefined,
    sessionId: "",
    runId: undefined,
    children: [],
  };
  const keys = new Set<string>([folderKey.root]);
  const empty = sessions.length === 0 && runs.length === 0 && tasks.length === 0;
  if (empty) return { root, count: 0, empty, folderKeys: keys };

  const scopedId = scope.sessionId ?? "";
  const known = new Set(sessions.map((session) => session.id));
  const groups = new Map<string, Content>();
  const group = (sessionId: string): Content => {
    const existing = groups.get(sessionId);
    if (existing) return existing;
    const fresh: Content = { runs: [], tasks: [] };
    groups.set(sessionId, fresh);
    return fresh;
  };
  const content = scopedId !== "" && known.has(scopedId) ? group(scopedId) : group("");
  content.runs.push(...runs);
  content.tasks.push(...tasks);

  const sortedSessions = [...sessions].sort(beforeSession);
  for (const session of sortedSessions) {
    root.children.push(sessionFolder(session, groups.get(session.id) ?? { runs: [], tasks: [] }));
  }
  const unfiled = groups.get("");
  if (unfiled && (unfiled.runs.length > 0 || unfiled.tasks.length > 0)) {
    root.children.push(sessionFolder({ id: "" }, unfiled));
  }

  const count = finalize(root, 0, keys);
  return { root, count, empty: false, folderKeys: keys };
}

// ---------------------------------------------------------------------------
// Expand / collapse state
// ---------------------------------------------------------------------------

/** Default view: the root and every session open, runs and tasks folded. */
export function defaultExpanded(tree: FolderTree): Set<string> {
  return new Set([folderKey.root, ...tree.root.children.map((child) => child.key)]);
}

export function toggleFolder(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function isExpanded(expanded: ReadonlySet<string>, key: string): boolean {
  return expanded.has(key);
}

export function expandAll(tree: FolderTree): Set<string> {
  return new Set(tree.folderKeys);
}

export function collapseAll(_tree: FolderTree): Set<string> {
  return new Set();
}

/**
 * The rows the browser draws: every folder whose ancestors are all expanded.
 * A collapsed folder still renders its own row, so the disclosure triangle
 * stays reachable, but its subtree does not.
 */
export function visibleFolders(tree: FolderTree, expanded: ReadonlySet<string>): FolderNode[] {
  const rows: FolderNode[] = [];
  const walk = (node: FolderNode): void => {
    rows.push(node);
    if (!expanded.has(node.key)) return;
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return rows;
}
