import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WorkerStatusSchema = z.enum([
  "pending",
  "preparing",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerRecordSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().uuid(),
  terminalId: z.string().optional(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  cwd: z.string().min(1),
  repoRoot: z.string().min(1),
  branch: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  status: WorkerStatusSchema,
  error: z.string().optional(),
  stopReason: z.string().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;

export const WorkerItemSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  branch: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
});
export type WorkerItemSpec = z.infer<typeof WorkerItemSpecSchema>;

export const WorkerLaunchInputSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  repoRoot: z.string().min(1),
  workers: z.array(WorkerItemSpecSchema).min(1),
});
export type WorkerLaunchInput = z.infer<typeof WorkerLaunchInputSchema>;

export const WorkerLaunchPayloadSchema = z.object({
  workers: z.array(WorkerRecordSchema),
});
export type WorkerLaunchPayload = z.infer<typeof WorkerLaunchPayloadSchema>;

export const WorkerListInputSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
});
export type WorkerListInput = z.infer<typeof WorkerListInputSchema>;

export const WorkerListPayloadSchema = z.object({
  workers: z.array(WorkerRecordSchema),
});
export type WorkerListPayload = z.infer<typeof WorkerListPayloadSchema>;

export const WorkerCancelInputSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  workerId: z.string().min(1),
});
export type WorkerCancelInput = z.infer<typeof WorkerCancelInputSchema>;

export const WorkerCancelPayloadSchema = z.object({
  worker: WorkerRecordSchema,
});
export type WorkerCancelPayload = z.infer<typeof WorkerCancelPayloadSchema>;

export const WorkerGetInputSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  workerId: z.string().min(1),
});
export type WorkerGetInput = z.infer<typeof WorkerGetInputSchema>;

export const WorkerGetPayloadSchema = z.object({
  worker: WorkerRecordSchema.nullable(),
});
export type WorkerGetPayload = z.infer<typeof WorkerGetPayloadSchema>;

export const WORKER_ERRORS = {
  NOT_GIT_REPO: "NOT_GIT_REPO",
  DUPLICATE_ID: "DUPLICATE_ID",
  MISSING_DEPENDENCY: "MISSING_DEPENDENCY",
  CYCLE_DETECTED: "CYCLE_DETECTED",
  WORKER_NOT_FOUND: "WORKER_NOT_FOUND",
  FOREIGN_OWNER: "FOREIGN_OWNER",
} as const;

export const launchWorkersRpc = defineRpc({
  name: "workers.launch",
  input: WorkerLaunchInputSchema,
  output: WorkerLaunchPayloadSchema,
});

export const listWorkersRpc = defineRpc({
  name: "workers.list",
  input: WorkerListInputSchema,
  output: WorkerListPayloadSchema,
});

export const cancelWorkerRpc = defineRpc({
  name: "workers.cancel",
  input: WorkerCancelInputSchema,
  output: WorkerCancelPayloadSchema,
});

export const getWorkerRpc = defineRpc({
  name: "workers.get",
  input: WorkerGetInputSchema,
  output: WorkerGetPayloadSchema,
});

export class WorkerError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerError";
  }
}
