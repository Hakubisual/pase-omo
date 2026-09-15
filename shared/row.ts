import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DagRunSchema, DagTaskSchema } from "./dag.js";

/** Timeline row kind published by this plugin and rendered in the agent chat. */
export const DAG_ROW_KIND = "omo-dag-run";
export const DAG_ROW_VERSION = 1;

export const DagChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.string(),
});

/** One dependency link between two chips in the same row. */
export const DagEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const DagRowSchema = z.object({
  runId: z.string(),
  name: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  layers: z.array(z.array(DagChipSchema)),
  /**
   * Defaulted rather than required: rows published before the card drew
   * dependency arrows are still sitting in the daemon's timeline, and the
   * renderer validates against this schema. A hard requirement would turn every
   * one of them into an "unavailable" card on the next render.
   */
  edges: z.array(DagEdgeSchema).default([]),
  truncated: z.boolean(),
});

export type DagChip = z.infer<typeof DagChipSchema>;
export type DagEdge = z.infer<typeof DagEdgeSchema>;
export type DagRow = z.infer<typeof DagRowSchema>;

/**
 * Stable fingerprint of everything the row renders, so unchanged runs are not
 * republished.
 *
 * Every field the card draws belongs here: a run that is renamed, that gains a
 * node label, or that starts truncating changes on screen without any node
 * changing state, and a signature built from states alone would hold the stale
 * card. `updatedAt` is deliberately absent — it is not rendered and it changes
 * on every write, which would defeat the dedupe entirely.
 */
export function rowSignature(row: DagRow): string {
  return JSON.stringify([
    row.name,
    row.status,
    row.total,
    row.completed,
    row.running,
    row.failed,
    row.truncated,
    row.layers.map((layer) => layer.map((chip) => [chip.id, chip.label, chip.state])),
    row.edges.map((edge) => [edge.from, edge.to]),
  ]);
}

/**
 * Full DAG snapshot for the current agent.
 *
 * The daemon resolves cwd and OmO session identity. Remote clients send only
 * the Paseo agent id and never inspect provider-native session-file paths.
 */
export const agentDagSnapshotRpc = defineRpc({
  name: "dag.agent-snapshot",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    sessionId: z.string().min(1).nullable(),
    runs: z.array(DagRunSchema),
    tasks: z.array(DagTaskSchema),
  }),
});
export type AgentDagSnapshotPayload = z.infer<typeof agentDagSnapshotRpc.output>;

/** Live runs for one agent, used by the composer pill and its popover graph. */
export const activeRunsRpc = defineRpc({
  name: "dag.active",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ rows: z.array(DagRowSchema) }),
});

/**
 * Statuses that mean "this run still has work to do".
 *
 * A queued run counts as live: it is the one about to move, and showing it is
 * how the card is already there when it starts.
 */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
  "scheduled",
  "running",
  "paused",
]);

/**
 * The single run the chat draws.
 *
 * One card per run buried the live graph under finished ones - on a phone that
 * means scrolling through history to find the thing that is actually happening.
 * A run that is still working always wins; when none is, the latest finished run
 * stays on screen so its final state is what the conversation ends on.
 */
export function currentRow(rows: readonly DagRow[]): DagRow | undefined {
  if (rows.length === 0) return undefined;
  const live = rows.filter((row) => LIVE_RUN_STATUSES.has(row.status));
  const pool = live.length > 0 ? live : rows;
  return [...pool].sort((left, right) =>
    left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
  )[0];
}
