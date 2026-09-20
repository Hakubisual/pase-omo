import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ApprovalMethodSchema = z.enum(["confirm", "select", "question"]);
export type ApprovalMethod = z.infer<typeof ApprovalMethodSchema>;

export const ApprovalOptionSchema = z.object({
  action: z.string().min(1),
  label: z.string().min(1),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

/** Matches Senpi RpcQuestionSpec; selections in replies use the original labels. */
export const ApprovalQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
});
export type ApprovalQuestion = z.infer<typeof ApprovalQuestionSchema>;

export const ApprovalQuestionAnswerSchema = z
  .object({
    selected: z.array(z.string()).refine((labels) => new Set(labels).size === labels.length, "중복 선택은 허용되지 않습니다."),
    text: z.string().optional(),
  })
  .strict()
  .refine((answer) => answer.selected.length > 0 || Boolean(answer.text?.trim()), "답변을 입력해 주세요.");
export const ApprovalQuestionAnswersSchema = z.record(z.string().min(1), ApprovalQuestionAnswerSchema);
export type ApprovalQuestionAnswers = z.infer<typeof ApprovalQuestionAnswersSchema>;

export const PendingApprovalRequestSchema = z.object({
  id: z.string().min(1),
  method: ApprovalMethodSchema,
  title: z.string().min(1),
  options: z.array(ApprovalOptionSchema),
  questionKey: z.string().min(1).optional(),
  questions: z.array(ApprovalQuestionSchema).optional(),
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

const StructuredApprovalResponseSchema = z
  .object({
    behavior: z.literal("allow"),
    answers: ApprovalQuestionAnswersSchema,
    comment: z.string().optional(),
  })
  .strict()
  .refine((response) => Object.keys(response.answers).length > 0 || Boolean(response.comment?.trim()), "답변이나 의견을 입력해 주세요.");

/**
 * Method-aware validation happens against the live pending request on the
 * server. This union first guarantees that clients send exactly one valid
 * response shape: deny, bare confirm allow, selected action, free text, or
 * structured Senpi answers with an optional comment. Partial answers and
 * comment-only submissions are supported; structured text is never trimmed.
 */
export const ApprovalResponseSchema = z.union([
  DenyApprovalResponseSchema,
  ConfirmApprovalResponseSchema,
  SelectApprovalResponseSchema,
  AnswerApprovalResponseSchema,
  StructuredApprovalResponseSchema,
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
