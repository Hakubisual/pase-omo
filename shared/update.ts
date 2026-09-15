import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * OmO ships on the beta dist-tag only ("Beta channel only: npm i -g omo-ai@beta"
 * in its own package description), so there is one channel to compare against
 * and one tag to install.
 */
export const OMO_PACKAGE = "omo-ai";
export const OMO_CHANNEL = "beta";

/**
 * Where a run of the update is.
 *
 * The daemon's plugin RPC gives a handler 30 seconds, and stopping every
 * session, installing a new CLI and starting them again does not fit in that -
 * the work completed while the caller was told it had failed. So applying is a
 * job that the status RPC reports on, not a call the button waits inside.
 */
export const OmoUpdatePhaseSchema = z.enum([
  "suspending",
  "installing",
  "resuming",
  "done",
  "failed",
]);
export type OmoUpdatePhase = z.infer<typeof OmoUpdatePhaseSchema>;

export const OmoUpdateJobSchema = z.object({
  phase: OmoUpdatePhaseSchema,
  /** False when only a restart was asked for. */
  install: z.boolean(),
  /** Sessions the job found when it started. */
  total: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  resumed: z.number().int().nonnegative(),
  /** One line per session that failed to stop or come back. */
  failures: z.array(z.string()),
  installError: z.string().nullable(),
  /** Version read back after the job finished. */
  version: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type OmoUpdateJob = z.infer<typeof OmoUpdateJobSchema>;

export const OmoUpdateStatusPayloadSchema = z.object({
  /** Version of the CLI this daemon would launch, when it can be read. */
  installedVersion: z.string().nullable(),
  /** Newest version on the beta tag, or null when the registry was unreachable. */
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** How many OmO sessions a restart would stop and resume. */
  liveSessions: z.number().int().nonnegative(),
  /** The exact command `update.apply` would run, for the button to show. */
  installCommand: z.string(),
  /** Why the check could not answer, when either version is null. */
  error: z.string().nullable(),
  /** The newest apply run, still going or finished. Null before the first one. */
  job: OmoUpdateJobSchema.nullable(),
});
export type OmoUpdateStatusPayload = z.infer<typeof OmoUpdateStatusPayloadSchema>;

export const ApplyOmoUpdateInputSchema = z.object({
  /**
   * False restarts the sessions without touching the install, which is what a
   * user who updated OmO by hand needs.
   */
  install: z.boolean(),
});
export type ApplyOmoUpdateInput = z.infer<typeof ApplyOmoUpdateInputSchema>;

export const ApplyOmoUpdatePayloadSchema = z.object({
  /** True when this call started the job; false when one was already running. */
  started: z.boolean(),
  alreadyRunning: z.boolean(),
  /** The job as it stands the moment the call returns. */
  job: OmoUpdateJobSchema,
});
export type ApplyOmoUpdatePayload = z.infer<typeof ApplyOmoUpdatePayloadSchema>;

export const omoUpdateStatusRpc = defineRpc({
  name: "update.status",
  input: z.object({}),
  output: OmoUpdateStatusPayloadSchema,
});

export const applyOmoUpdateRpc = defineRpc({
  name: "update.apply",
  input: ApplyOmoUpdateInputSchema,
  output: ApplyOmoUpdatePayloadSchema,
});
