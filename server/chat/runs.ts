import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DagRowSchema, type DagChip, type DagEdge, type DagRow } from "../../shared/row";
import { invalidRecord } from "../dag/dag-store.js";
import { dagRunsDir } from "../task-state.js";

/** Node chips beyond this are dropped from the row; the card says it truncated. */
const MAX_NODES = 60;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads one JSON record, or `undefined` when there is no such file.
 *
 * Records are written by atomic rename, so a reader never observes a
 * half-written file: it sees the previous one or nothing. A file that is absent
 * is therefore the only benign failure. A permission error, an I/O error, or
 * unparseable content is real, and reporting it as "this chat has no DAG" hides
 * a broken store behind an empty card.
 */
async function readJson(file: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw invalidRecord(basename(file), { path: file, cause: error });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw invalidRecord(basename(file), { path: file, cause: error });
  }
}

function sessionIdFromRuntime(runtimeSessionId: string): string | null {
  const brace = runtimeSessionId.indexOf("{");
  if (brace < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(runtimeSessionId.slice(brace)) as unknown;
  } catch {
    return null;
  }
  const file = (parsed as { data?: { sessionFile?: unknown } } | null)?.data?.sessionFile;
  if (typeof file !== "string") return null;
  const name = basename(file).replace(/\.jsonl$/i, "");
  const underscore = name.indexOf("_");
  return underscore >= 0 ? name.slice(underscore + 1) : name;
}

export type AgentOrigin = {
  cwd: string | null;
  sessionId: string | null;
};

/** Reads the daemon's agent record: its working directory and its OmO session. */
export async function resolveAgent(agentId: string): Promise<AgentOrigin> {
  const agentsDir = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "agents");
  let groups: string[];
  try {
    groups = await readdir(agentsDir);
  } catch (error) {
    // A daemon that has never written an agent record has no directory; that is
    // "no agents", not a failure. Anything else is a real read error.
    if ((error as { code?: string }).code === "ENOENT") return { cwd: null, sessionId: null };
    throw invalidRecord("agents directory", { path: agentsDir, cause: error });
  }
  for (const group of groups) {
    const record = (await readJson(join(agentsDir, group, `${agentId}.json`))) as {
      cwd?: unknown;
      runtimeInfo?: { sessionId?: unknown };
    } | null;
    if (!record) continue;
    const runtime = record.runtimeInfo?.sessionId;
    return {
      cwd: text(record.cwd),
      sessionId: typeof runtime === "string" ? sessionIdFromRuntime(runtime) : null,
    };
  }
  return { cwd: null, sessionId: null };
}

/** Maps a Paseo agent to the OmO session whose DAG runs belong to that chat. */
export async function resolveSessionId(agentId: string): Promise<string | null> {
  return (await resolveAgent(agentId)).sessionId;
}

type RawNode = {
  id?: unknown;
  label?: unknown;
  state?: unknown;
  dependsOn?: unknown;
};

type ParsedNode = {
  id: string;
  label: string;
  state: string;
  dependsOn: string[];
};

function parseNodes(value: unknown): ParsedNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: ParsedNode[] = [];
  for (const entry of value as RawNode[]) {
    const id = text(entry?.id);
    if (!id) continue;
    nodes.push({
      id,
      label: text(entry?.label) ?? id,
      state: text(entry?.state) ?? "pending",
      dependsOn: Array.isArray(entry?.dependsOn)
        ? (entry.dependsOn as unknown[]).filter((dep): dep is string => typeof dep === "string")
        : [],
    });
  }
  return nodes;
}

/** Groups nodes into dependency layers: layer index is the longest path from a root. */
function layersOf(nodes: ParsedNode[]): DagChip[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) depth = Math.max(depth, depthOf(dep) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };

  const layers: DagChip[][] = [];
  for (const node of nodes) {
    const depth = depthOf(node.id);
    while (layers.length <= depth) layers.push([]);
    layers[depth]?.push({ id: node.id, label: node.label, state: node.state });
  }
  return layers.filter((layer) => layer.length > 0);
}

/**
 * Dependency links between nodes the card actually draws.
 *
 * Both endpoints must survive truncation: a link into a node that was dropped
 * would render as an arrow pointing at empty canvas.
 */
function edgesOf(nodes: ParsedNode[]): DagEdge[] {
  const kept = new Set(nodes.map((node) => node.id));
  const edges: DagEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (kept.has(dep)) edges.push({ from: dep, to: node.id });
    }
  }
  return edges;
}

function countState(nodes: ParsedNode[], state: string): number {
  return nodes.filter((node) => node.state === state).length;
}

function toRow(raw: unknown): DagRow | null {
  const record = raw as {
    schemaVersion?: unknown;
    runId?: unknown;
    name?: unknown;
    status?: unknown;
    updatedAt?: unknown;
    nodes?: unknown;
  } | null;
  if (record?.schemaVersion !== 1) return null;
  const runId = text(record.runId);
  if (!runId) return null;
  const nodes = parseNodes(record.nodes);
  if (nodes.length === 0) return null;
  const kept = nodes.slice(0, MAX_NODES);
  const parsed = DagRowSchema.safeParse({
    runId,
    name: text(record.name) ?? runId,
    status: text(record.status) ?? "pending",
    updatedAt: text(record.updatedAt) ?? new Date(0).toISOString(),
    total: nodes.length,
    completed: countState(nodes, "completed"),
    running: countState(nodes, "running"),
    failed: countState(nodes, "failed") + countState(nodes, "cancelled"),
    layers: layersOf(kept),
    edges: edgesOf(kept),
    truncated: kept.length < nodes.length,
  });
  return parsed.success ? parsed.data : null;
}

/** Reads this session's DAG runs that changed at or after `sinceMs`, oldest first. */
export async function readRows(cwd: string, sessionId: string | null, sinceMs: number): Promise<DagRow[]> {
  const directory = dagRunsDir(cwd);
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    // No run directory means no runs have been written for this workspace.
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw invalidRecord("run directory", { path: directory, cause: error });
  }
  const dated: { row: DagRow; at: number }[] = [];
  for (const file of files) {
    const raw = await readJson(join(directory, file));
    const owner = (raw as { parentSessionId?: unknown; rootSessionId?: unknown } | null) ?? {};
    if (sessionId && owner.parentSessionId !== sessionId && owner.rootSessionId !== sessionId) continue;
    const row = toRow(raw);
    if (!row) continue;
    // `Date.parse` answers NaN for a timestamp it cannot read, and every
    // comparison against NaN is false: such a row would slip through the
    // lookback it fails and then sort into an arbitrary position. A run whose
    // time is unreadable cannot be placed in the window, so it is left out.
    const at = Date.parse(row.updatedAt);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    dated.push({ row, at });
  }
  // `runId` breaks ties so runs written within the same millisecond keep one
  // order across reads instead of depending on directory listing order.
  dated.sort((left, right) => left.at - right.at || left.row.runId.localeCompare(right.row.runId));
  return dated.map((entry) => entry.row);
}
