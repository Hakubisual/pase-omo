import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * OmO ships on the beta dist-tag only ("Beta channel only: npm i -g omo-ai@beta"
 * in its own package description), so there is one channel to compare against
 * and one tag to install.
 */
export const OMO_PACKAGE = "omo-ai";
export const OMO_CHANNEL = "beta";

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
  installed: z.boolean(),
  /** Version read back after the install step, when it could be read. */
  version: z.string().nullable(),
  resumed: z.number().int().nonnegative(),
  /** One line per session that failed to come back, `sessionId: reason`. */
  failures: z.array(z.string()),
  /** Install failure, reported with the sessions still resumed. */
  installError: z.string().nullable(),
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
