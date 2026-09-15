import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DagTaskSchema = z.object({
  id: z.string().regex(/^st_[A-Za-z0-9_-]{1,253}$/),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
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
      taskId: z.string().optional(),
      error: z.string(),
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
