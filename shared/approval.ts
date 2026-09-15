import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ApprovalMethodSchema = z.enum(["confirm", "select", "question"]);
export type ApprovalMethod = z.infer<typeof ApprovalMethodSchema>;

export const ApprovalOptionSchema = z.object({
  action: z.string().min(1),
  label: z.string().min(1),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const PendingApprovalRequestSchema = z.object({
  id: z.string().min(1),
  method: ApprovalMethodSchema,
  title: z.string().min(1),
  options: z.array(ApprovalOptionSchema),
  questionKey: z.string().min(1).optional(),
});
export type PendingApprovalRequest = z.infer<typeof PendingApprovalRequestSchema>;

const DenyApprovalResponseSchema = z.object({ behavior: z.literal("deny") }).strict();
const ConfirmApprovalResponseSchema = z.object({ behavior: z.literal("allow") }).strict();
const SelectApprovalResponseSchema = z
  .object({
    behavior: z.literal("allow"),
    action: z.string().min(1),
  })
  .strict();
const AnswerApprovalResponseSchema = z
  .object({
    behavior: z.literal("allow"),
    answer: z.string().trim().min(1),
  })
  .strict();

/**
 * Method-aware validation happens against the live pending request on the
 * server. This union first guarantees that clients send exactly one valid
 * response shape: deny, bare confirm allow, selected action, or free text.
 */
export const ApprovalResponseSchema = z.union([
  DenyApprovalResponseSchema,
  ConfirmApprovalResponseSchema,
  SelectApprovalResponseSchema,
  AnswerApprovalResponseSchema,
]);
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export const ListPendingApprovalsInputSchema = z.object({
  agentId: z.string().min(1),
});
export type ListPendingApprovalsInput = z.infer<typeof ListPendingApprovalsInputSchema>;

export const ListPendingApprovalsPayloadSchema = z.object({
  requests: z.array(PendingApprovalRequestSchema),
});
export type ListPendingApprovalsPayload = z.infer<typeof ListPendingApprovalsPayloadSchema>;

export const SubmitApprovalInputSchema = z.object({
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  response: ApprovalResponseSchema,
});
export type SubmitApprovalInput = z.infer<typeof SubmitApprovalInputSchema>;

export const SubmitApprovalPayloadSchema = z.object({ submitted: z.literal(true) });
export type SubmitApprovalPayload = z.infer<typeof SubmitApprovalPayloadSchema>;

export const listPendingApprovalsRpc = defineRpc({
  name: "approval.pending",
  input: ListPendingApprovalsInputSchema,
  output: ListPendingApprovalsPayloadSchema,
});

export const submitApprovalResponseRpc = defineRpc({
  name: "approval.respond",
  input: SubmitApprovalInputSchema,
  output: SubmitApprovalPayloadSchema,
});
