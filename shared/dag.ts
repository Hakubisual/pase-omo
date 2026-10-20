import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DagTaskSchema = z.object({
  id: z.string().regex(/^st_[A-Za-z0-9_-]{1,253}$/),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  modelRef: z.string().optional(),
  modelStage: z.enum(["effective", "resolved", "planned"]).optional(),
  requestedModel: z.string().optional(),
  resolvedModel: z.string().optional(),
  reasoning: z.string().optional(),
  variant: z.string().optional(),
  modelAttempts: z.array(z.object({ model: z.string(), reasoning: z.string().optional(), variant: z.string().optional() })).max(20).optional(),
  modelAttemptCount: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z.string().optional(),
  progressAt: z.string().optional(),
  terminalReason: z.string().optional(),
  lastActivityAt: z.string().optional(),
  lastTool: z.string().optional(),
  observedToolCalls: z.number().int().nonnegative().optional(),
  activityError: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  parentTaskId: z.string().optional(),
});
export type DagTask = z.infer<typeof DagTaskSchema>;

const DagStatusSchema = z.enum([
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
export type DagStatus = z.infer<typeof DagStatusSchema>;

export const DagRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: DagStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      state: DagStatusSchema,
      attempt: z.number().int().nonnegative(),
      execAttempt: z.number().int().nonnegative().optional(),
      taskId: z.string().optional(),
      error: z.string(),
      route: z.string().optional(),
      routeKind: z.enum(["category", "agent"]).optional(),
      requestedModel: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      outputPreview: z.string().max(2000).optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputTruncated: z.boolean().optional(),
      diagnostics: z.array(z.object({ kind: z.string(), message: z.string(), at: z.string().optional() })).max(20).optional(),
      diagnosticCount: z.number().int().nonnegative().optional(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});
export type DagRun = z.infer<typeof DagRunSchema>;
export type DagRunNode = DagRun["nodes"][number];

export const DagSessionSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  taskCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  /** DAG runs and tasks that are running right now, so a live session is findable. */
  runningCount: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
});
export type DagSession = z.infer<typeof DagSessionSchema>;

export const listSessionsRpc = defineRpc({
  name: "dag.sessions",
  input: z.object({ cwd: z.string().trim().min(1) }),
  output: z.object({ sessions: z.array(DagSessionSchema) }),
});

export const DagProjectSchema = z.object({
  cwd: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type DagProject = z.infer<typeof DagProjectSchema>;

/**
 * Projects that have OmO sessions on this daemon, most recent first.
 *
 * The global surface has no workspace to inherit a path from, and asking a user
 * to type an absolute path is how that surface ended up always empty.
 */
export const listProjectsRpc = defineRpc({
  name: "dag.projects",
  input: z.object({}),
  output: z.object({ projects: z.array(DagProjectSchema) }),
});

export const getSnapshotRpc = defineRpc({
  name: "dag.snapshot",
  input: z.object({ cwd: z.string().trim().min(1), sessionId: z.string().min(1) }),
  output: z.object({
    sessionId: z.string().min(1),
    tasks: z.array(DagTaskSchema),
    runs: z.array(DagRunSchema),
  }),
});

export type DagSessionsInput = z.infer<typeof listSessionsRpc.input>;
export type DagSessionsPayload = z.infer<typeof listSessionsRpc.output>;
export type DagSnapshotInput = z.infer<typeof getSnapshotRpc.input>;
export type DagSnapshotPayload = z.infer<typeof getSnapshotRpc.output>;

export const WorkerOutputEntrySchema = z.object({
  id: z.string().max(80),
  type: z.enum(["assistant", "tool_call", "tool_result", "final"]),
  text: z.string().max(8000),
  toolName: z.string().max(128).optional(),
  toolCallId: z.string().max(256).optional(),
  isError: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type WorkerOutputEntry = z.infer<typeof WorkerOutputEntrySchema>;

/** Read-only output for a worker verified to belong to this session. */
export const workerOutputRpc = defineRpc({
  name: "dag.worker-output",
  input: z.object({
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    taskId: z.string().regex(/^st_[A-Za-z0-9_-]{1,253}$/),
  }).refine(input => Boolean(input.agentId || (input.cwd && input.sessionId)), "A session scope is required"),
  output: z.object({
    taskId: z.string(),
    text: z.string(),
    /** Optional for older hosts; new readers preserve message/tool boundaries. */
    entries: z.array(WorkerOutputEntrySchema).max(80).optional(),
    truncated: z.boolean(),
    warning: z.string().optional(),
  }),
});
export type WorkerOutput = z.infer<typeof workerOutputRpc.output>;
export type WorkerScope = { agentId: string } | { cwd: string; sessionId: string };
