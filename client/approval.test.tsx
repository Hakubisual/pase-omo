import type { PluginTheme } from "@getpaseo/plugin";
import React, { type ReactElement, type ReactNode } from "react";
import { Dimensions } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingApprovalRequest, SubmitApprovalInput } from "../shared/approval.js";
import { ApprovalRequestModal, createApprovalSubmitter } from "./approval.js";

const theme: PluginTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f8fafc",
    surface2: "#eef2f6",
    border: "#d8dee8",
    foreground: "#111827",
    foregroundMuted: "#64748b",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    statusSuccess: "#16a34a",
    statusWarning: "#d97706",
    statusDanger: "#dc2626",
  },
};

type ElementProps = {
  accessibilityLabel?: string;
  children?: ReactNode;
  ellipsizeMode?: string;
  numberOfLines?: number;
  onChangeText?: (value: string) => void;
  onPress?: () => void | Promise<void>;
  style?: unknown;
  testID?: string;
};

function descendants(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!React.isValidElement<ElementProps>(node)) return [];
  return [node, ...descendants(node.props.children)];
}

function control(tree: ReactNode, label: string): ReactElement<ElementProps> {
  const found = descendants(tree).find((element) => element.props.accessibilityLabel === label);
  if (!found) throw new Error(`Missing control: ${label}`);
  return found;
}

function byTestId(tree: ReactNode, testID: string): ReactElement<ElementProps> {
  const found = descendants(tree).find((element) => element.props.testID === testID);
  if (!found) throw new Error(`Missing test id: ${testID}`);
  return found;
}

function textElement(tree: ReactNode, text: string): ReactElement<ElementProps> {
  const found = descendants(tree).find((element) => element.props.children === text);
  if (!found) throw new Error(`Missing text: ${text}`);
  return found;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}

async function press(tree: ReactNode, label: string): Promise<void> {
  const onPress = control(tree, label).props.onPress;
  if (!onPress) throw new Error(`Control is not pressable: ${label}`);
  await onPress();
}

function typeInto(tree: ReactNode, label: string, value: string): void {
  const onChangeText = control(tree, label).props.onChangeText;
  if (!onChangeText) throw new Error(`Control is not editable: ${label}`);
  onChangeText(value);
}

function request(partial: Partial<PendingApprovalRequest> & Pick<PendingApprovalRequest, "id" | "method" | "title">): PendingApprovalRequest {
  return {
    options: [],
    ...partial,
  };
}

function harness(pending: PendingApprovalRequest) {
  let answer = "";
  const rpc = vi.fn(async (_input: SubmitApprovalInput) => ({ submitted: true as const }));
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const submit = createApprovalSubmitter({
    agentId: "agent-1",
    requestId: pending.id,
    submitRpc: rpc,
    onSubmitted: () => onOpenChange(false),
  });
  const render = () =>
    ApprovalRequestModal({
      open: true,
      request: pending,
      answer,
      submitting: false,
      theme,
      layout: { compact: false, platform: "web" },
      onAnswerChange: (value) => {
        answer = value;
      },
      onOpenChange,
      onRespond: submit,
    });

  return { onOpenChange, render, rpc };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalRequestModal", () => {
  it("submits confirm allow exactly once and closes after success", async () => {
    const ui = harness(request({ id: "confirm-1", method: "confirm", title: "Deploy now?" }));
    const tree = ui.render();

    await press(tree, "승인");
    await press(tree, "승인");

    expect(ui.rpc).toHaveBeenCalledTimes(1);
    expect(ui.rpc).toHaveBeenCalledWith({
      agentId: "agent-1",
      requestId: "confirm-1",
      response: { behavior: "allow" },
    });
    expect(ui.onOpenChange).toHaveBeenCalledTimes(1);
    expect(ui.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("submits deny exactly once", async () => {
    const ui = harness(request({ id: "confirm-2", method: "confirm", title: "Delete cache?" }));

    await press(ui.render(), "거부");

    expect(ui.rpc).toHaveBeenCalledTimes(1);
    expect(ui.rpc).toHaveBeenCalledWith({
      agentId: "agent-1",
      requestId: "confirm-2",
      response: { behavior: "deny" },
    });
  });

  it("submits the selected action", async () => {
    const ui = harness(
      request({
        id: "select-1",
        method: "select",
        title: "Choose a target",
        options: [
          { action: "option-0", label: "Staging" },
          { action: "option-1", label: "Production" },
        ],
      }),
    );

    await press(ui.render(), "Production 선택");

    expect(ui.rpc).toHaveBeenCalledTimes(1);
    expect(ui.rpc).toHaveBeenCalledWith({
      agentId: "agent-1",
      requestId: "select-1",
      response: { behavior: "allow", action: "option-1" },
    });
  });

  it("submits a typed free-text answer for the pending question", async () => {
    const ui = harness(
      request({
        id: "question-1",
        method: "question",
        title: "Which region should be used?",
        questionKey: "deploy_region",
        options: [{ action: "option-0", label: "Use nearest" }],
      }),
    );

    typeInto(ui.render(), "답변 입력", "ap-northeast-2");
    await press(ui.render(), "답변 보내기");

    expect(ui.rpc).toHaveBeenCalledTimes(1);
    expect(ui.rpc).toHaveBeenCalledWith({
      agentId: "agent-1",
      requestId: "question-1",
      response: { behavior: "allow", answer: "ap-northeast-2" },
    });
  });

  it("shortens daemon-local absolute paths received through RPC data", () => {
    const windowsPath = "E:\\DEV\\daemon-only\\plans\\release-plan.md";
    const posixPath = "/srv/paseo/daemon-only/deploy/production";
    const tree = ApprovalRequestModal({
      open: true,
      request: request({
        id: "select-remote",
        method: "select",
        title: windowsPath,
        options: [{ action: "option-0", label: posixPath }],
      }),
      answer: "",
      submitting: false,
      theme,
      layout: { compact: true, platform: "android" },
      onAnswerChange: vi.fn(),
      onOpenChange: vi.fn(),
      onRespond: vi.fn(),
    });

    expect(textElement(tree, "…/release-plan.md")).toBeDefined();
    expect(textElement(tree, "…/production")).toBeDefined();
    expect(control(tree, "…/production 선택")).toBeDefined();
    expect(descendants(tree).some((element) => element.props.children === windowsPath)).toBe(false);
    expect(descendants(tree).some((element) => element.props.children === posixPath)).toBe(false);
  });

  it("puts the send button above the skip button on a phone", () => {
    vi.spyOn(Dimensions, "get").mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const render = (compact: boolean) =>
      ApprovalRequestModal({
        open: true,
        request: request({ id: "q-1", method: "question", title: "Which region?" }),
        answer: "ap-northeast-2",
        submitting: false,
        theme,
        layout: { compact, platform: compact ? "ios" : "web" },
        onAnswerChange: vi.fn(),
        onOpenChange: vi.fn(),
        onRespond: vi.fn(),
      });

    // Both controls exist in the same order in the tree; only the direction the
    // stack grows decides which one the screen shows first. Skipping was the
    // only reachable answer on a phone while this was a plain column.
    const compactActions = byTestId(render(true), "approval-actions");
    const order = descendants(compactActions.props.children)
      .map((element) => element.props.accessibilityLabel)
      .filter((label): label is string => label === "건너뛰기" || label === "답변 보내기");
    expect(order).toEqual(["건너뛰기", "답변 보내기"]);
    expect(flattenStyle(compactActions.props.style).flexDirection).toBe("column-reverse");

    // A wide row still reads deny-then-allow from left to right.
    expect(flattenStyle(byTestId(render(false), "approval-actions").props.style).flexDirection).toBe(
      "row",
    );
  });

  it("keeps every primary label legible inside a compact 390px viewport", () => {
    vi.spyOn(Dimensions, "get").mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const title = "Choose the deployment destination for this long-running mobile release";
    const firstOption = "Production in Asia Pacific Northeast with automatic failover";
    const secondOption = "Staging environment with the complete integration verification suite";

    const tree = ApprovalRequestModal({
      open: true,
      request: request({
        id: "select-mobile",
        method: "select",
        title,
        options: [
          { action: "option-0", label: firstOption },
          { action: "option-1", label: secondOption },
        ],
      }),
      answer: "",
      submitting: false,
      theme,
      layout: { compact: true, platform: "ios" },
      onAnswerChange: vi.fn(),
      onOpenChange: vi.fn(),
      onRespond: vi.fn(),
    });

    expect(flattenStyle(byTestId(tree, "approval-body").props.style)).toMatchObject({
      width: "100%",
      maxWidth: 390,
      overflow: "hidden",
    });
    // Reversed, so the primary action sits on top of the stack instead of
    // below the bottom edge of the screen.
    expect(flattenStyle(byTestId(tree, "approval-actions").props.style)).toMatchObject({
      width: "100%",
      flexDirection: "column-reverse",
    });

    for (const label of [title, firstOption, secondOption, "취소"]) {
      const element = textElement(tree, label);
      expect(element.props.ellipsizeMode).toBe("tail");
      expect(element.props.numberOfLines).toBeGreaterThanOrEqual(1);
      expect(flattenStyle(element.props.style)).toMatchObject({ maxWidth: "100%", flexShrink: 1 });
    }

    for (const label of [`${firstOption} 선택`, `${secondOption} 선택`, "거부"]) {
      const style = flattenStyle(control(tree, label).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.width).toBe("100%");
    }

    for (const element of descendants(tree)) {
      const style = flattenStyle(element.props.style);
      if (typeof style.width === "number") expect(style.width).toBeLessThanOrEqual(390);
      if (typeof style.maxWidth === "number") expect(style.maxWidth).toBeLessThanOrEqual(390);
    }
  });
});
