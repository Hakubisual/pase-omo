import { describe, expect, it } from "vitest";

import { ApprovalResponseSchema, PendingApprovalRequestSchema } from "./approval.js";

const questions = [
  {
    id: "features",
    header: "기능",
    question: "어떤 기능을 사용할까요?",
    options: Array.from({ length: 10 }, (_, index) => ({
      label: `feature-${index}`,
      description: `description-${index}`,
    })),
    multiSelect: true,
  },
  { id: "notes", header: "메모", question: "추가 요청이 있나요?", options: [], multiSelect: false },
];

describe("structured approval schema", () => {
  it("preserves every question, option, description, and multiSelect field", () => {
    const request = { id: "q", method: "question", title: "질문", options: [], questions };
    expect(PendingApprovalRequestSchema.parse(request)).toEqual(request);
  });

  it("preserves selected labels, free text, and comment exactly", () => {
    const response = {
      behavior: "allow",
      answers: {
        features: { selected: ["feature-0", "feature-9"], text: "  추가 설명\n" },
        notes: { selected: [], text: "  자유 입력\n" },
      },
      comment: "  전체 의견\n",
    };
    expect(ApprovalResponseSchema.parse(response)).toEqual(response);
  });

  it("allows partial answers and comment-only replies", () => {
    expect(ApprovalResponseSchema.safeParse({ behavior: "allow", answers: { notes: { selected: [], text: "메모" } } }).success).toBe(true);
    expect(ApprovalResponseSchema.safeParse({ behavior: "allow", answers: {}, comment: "의견" }).success).toBe(true);
  });

  it.each([
    { behavior: "allow", answers: {} },
    { behavior: "allow", answers: {}, comment: "  " },
    { behavior: "allow", answers: { notes: { selected: [] } } },
    { behavior: "allow", answers: { notes: { selected: [], text: "  " } } },
    { behavior: "allow", answers: { notes: { selected: "feature-0" } } },
    { behavior: "allow", answers: { notes: { selected: ["feature-0", "feature-0"] } } },
    { behavior: "allow", answers: { notes: { selected: [], text: 1 } } },
    { behavior: "allow", answers: { notes: { selected: [], text: "ok", extra: true } } },
    { behavior: "allow", answers: {}, comment: 1 },
    { behavior: "allow", answers: {}, comment: "ok", action: "option-0" },
    { behavior: "deny", answers: {}, comment: "ok" },
  ])("rejects malformed or empty structured response %#", (response) => {
    expect(ApprovalResponseSchema.safeParse(response).success).toBe(false);
  });

  it("retains the existing confirmation, selection, and text contracts", () => {
    for (const response of [
      { behavior: "deny" },
      { behavior: "allow" },
      { behavior: "allow", action: "option-0" },
      { behavior: "allow", answer: "기존 답변" },
    ]) {
      expect(ApprovalResponseSchema.parse(response)).toEqual(response);
    }
  });
});
