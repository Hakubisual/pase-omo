import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DagDestinationSchema = z.object({
  cwd: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});
export type DagDestination = z.infer<typeof DagDestinationSchema>;

/**
 * Resolves what a conversation, DAG card or task card points at in the dashboard.
 *
 * The daemon answers because ownership lives in the session records: a child
 * session's work belongs to the top-level session the dashboard lists, and the
 * newest session is never a safe guess. The client sends only the Paseo agent id
 * (or an explicit session), never a provider-native path.
 */
export const locateDagRpc = defineRpc({
  name: "dag.locate",
  input: z.object({
    agentId: z.string().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  }),
  output: z.object({
    destination: DagDestinationSchema.nullable(),
    /** Why the destination is missing or incomplete, shown to the user as written. */
    reason: z.string().optional(),
  }),
});

export type LocateDagPayload = z.infer<typeof locateDagRpc.output>;
