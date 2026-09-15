import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Dimensions, Pressable, StyleSheet, Text, View } from "react-native";

import {
  listPendingApprovalsRpc,
  submitApprovalResponseRpc,
  type ApprovalResponse,
  type ListPendingApprovalsPayload,
  type PendingApprovalRequest,
  type SubmitApprovalInput,
  type SubmitApprovalPayload,
} from "../shared/approval.js";

const REFRESH_MS = 1_000;
const queryKey = (agentId: string | null) => ["omo-approval", agentId] as const;

function usePendingApprovalQuery(agentId: string | null, enabled: boolean) {
  const listPending = useRpc(listPendingApprovalsRpc);
  return useQuery({
    queryKey: queryKey(agentId),
    enabled: enabled && agentId !== null,
    refetchInterval: enabled ? REFRESH_MS : false,
    queryFn: () => listPending({ agentId: agentId as string }),
  });
}

/** Small badge-facing hook: true while this agent has at least one pending OmO UI request. */
export function useHasPendingApproval(agentId: string | null): boolean {
  const query = usePendingApprovalQuery(agentId, true);
  return (query.data?.requests.length ?? 0) > 0;
}

export interface ApprovalSubmitterOptions {
  agentId: string;
  requestId: string;
  submitRpc(input: SubmitApprovalInput): Promise<SubmitApprovalPayload>;
  onSubmitted(): void;
}

/**
 * Serializes a modal's response. A successful request is terminal, while a
 * failed request unlocks so the user can retry without reopening the popup.
 */
export function createApprovalSubmitter({
  agentId,
  requestId,
  submitRpc,
  onSubmitted,
}: ApprovalSubmitterOptions): (response: ApprovalResponse) => Promise<boolean> {
  let inFlight = false;
  let submitted = false;
  return async (response) => {
    if (inFlight || submitted) return false;
    inFlight = true;
    try {
      await submitRpc({ agentId, requestId, response });
      submitted = true;
      onSubmitted();
      return true;
    } catch (error) {
      inFlight = false;
      throw error;
    }
  };
}

function modalTitle(method: PendingApprovalRequest["method"]): string {
  if (method === "confirm") return "OmO 승인 요청";
  if (method === "select") return "OmO 선택 요청";
  return "OmO 질문";
}

/**
 * A remote viewer cannot open paths from the daemon machine. Keep the RPC value
 * intact for responses, but present absolute path labels as a basename only.
 */
export function remoteSafeLabel(value: string): string {
  const trimmed = value.trim();
  const absolute =
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(trimmed) ||
    /^\/(?!\/)/.test(trimmed);
  if (!absolute) return value;
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "");
  const basename = withoutTrailingSeparators.split(/[\\/]/).at(-1);
  return basename ? `…/${basename}` : "…/";
}

function createStyles(theme: PluginTheme, compact: boolean, viewportWidth: number) {
  const maxWidth = Math.min(viewportWidth, compact ? 390 : 640);
  return StyleSheet.create({
    content: { width: "100%", maxWidth, alignSelf: "center", overflow: "hidden" },
    body: { width: "100%", maxWidth, alignSelf: "center", overflow: "hidden", gap: compact ? 12 : 16 },
    title: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.foreground,
      fontSize: compact ? 15 : 16,
      lineHeight: compact ? 22 : 23,
      fontWeight: "600",
    },
    hint: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 19,
    },
    optionList: { width: "100%", maxWidth: "100%", gap: 8 },
    option: {
      width: "100%",
      maxWidth: "100%",
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: compact ? 12 : 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderRadius: 9,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      overflow: "hidden",
    },
    optionText: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.foreground,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "500",
    },
    input: {
      width: "100%",
      maxWidth: "100%",
      // Shorter on a phone: every point this box takes is a point the send
      // button has to find below it.
      minHeight: compact ? 72 : 96,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderRadius: 9,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      textAlignVertical: "top",
    },
    actions: {
      width: "100%",
      maxWidth: "100%",
      // Stacked on a phone, and reversed so the primary action is the one on
      // top. A row reads deny-then-allow left to right, but a column puts the
      // last child furthest down the screen - which is how the send button for
      // a typed answer ended up below the bottom edge, leaving a request that
      // could only be skipped.
      flexDirection: compact ? "column-reverse" : "row",
      alignItems: "stretch",
      justifyContent: "flex-end",
      gap: 8,
    },
    button: {
      width: compact ? "100%" : undefined,
      maxWidth: "100%",
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 8,
      overflow: "hidden",
    },
    denyButton: { borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    allowButton: { backgroundColor: theme.colors.accent },
    disabled: { opacity: 0.5 },
    denyText: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.statusDanger,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "600",
      textAlign: "center",
    },
    allowText: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.accentForeground,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "600",
      textAlign: "center",
    },
    empty: { maxWidth: "100%", flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
    error: { maxWidth: "100%", flexShrink: 1, color: theme.colors.statusDanger, fontSize: 14, lineHeight: 20 },
  });
}

export interface ApprovalRequestModalProps {
  open: boolean;
  request: PendingApprovalRequest;
  answer: string;
  submitting: boolean;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  onAnswerChange(value: string): void;
  onOpenChange(open: boolean): void;
  onRespond(response: ApprovalResponse): void | Promise<unknown>;
}

export type ApprovalRequestBodyProps = Omit<ApprovalRequestModalProps, "open" | "onOpenChange">;

/**
 * The request's controls, stateless so every visible action maps to one
 * response shape.
 *
 * Callers invoke this directly instead of mounting it as a child element, so
 * the modal and the composer pill popover inline the same tree rather than
 * owning two copies of it.
 */
export function ApprovalRequestBody({
  request,
  answer,
  submitting,
  theme,
  layout,
  onAnswerChange,
  onRespond,
}: ApprovalRequestBodyProps): React.JSX.Element {
  const styles = createStyles(theme, layout.compact, Dimensions.get("window").width);
  const answerReady = answer.trim().length > 0;
  const displayTitle = remoteSafeLabel(request.title);

  return (
    <View testID="approval-body" style={styles.body}>
      <Text style={styles.title} numberOfLines={layout.compact ? 3 : 4} ellipsizeMode="tail">
        {displayTitle}
      </Text>

      {request.method === "question" ? (
        <>
          {request.options.length > 0 ? (
            <View style={styles.optionList}>
              <Text style={styles.hint} numberOfLines={1} ellipsizeMode="tail">
                추천 답변
              </Text>
              {request.options.map((option) => (
                <Pressable
                  key={option.action}
                  accessibilityRole="button"
                  accessibilityLabel={`${remoteSafeLabel(option.label)} 선택`}
                  disabled={submitting}
                  style={[styles.option, submitting && styles.disabled]}
                  onPress={() => onRespond({ behavior: "allow", action: option.action })}
                >
                  <Text style={styles.optionText} numberOfLines={2} ellipsizeMode="tail">
                    {remoteSafeLabel(option.label)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextInput
            accessibilityLabel="답변 입력"
            value={answer}
            editable={!submitting}
            multiline
            placeholder="답변을 입력하세요"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            onChangeText={onAnswerChange}
          />
          <View testID="approval-actions" style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="건너뛰기"
              disabled={submitting}
              style={[styles.button, styles.denyButton, submitting && styles.disabled]}
              onPress={() => onRespond({ behavior: "deny" })}
            >
              <Text style={styles.denyText} numberOfLines={1} ellipsizeMode="tail">
                건너뛰기
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="답변 보내기"
              disabled={submitting || !answerReady}
              style={[styles.button, styles.allowButton, (submitting || !answerReady) && styles.disabled]}
              onPress={() => onRespond({ behavior: "allow", answer: answer.trim() })}
            >
              <Text style={styles.allowText} numberOfLines={1} ellipsizeMode="tail">
                {submitting ? "전송 중" : "답변 보내기"}
              </Text>
            </Pressable>
          </View>
        </>
      ) : request.method === "select" ? (
        <>
          <View style={styles.optionList}>
            {request.options.map((option) => (
              <Pressable
                key={option.action}
                accessibilityRole="button"
                accessibilityLabel={`${remoteSafeLabel(option.label)} 선택`}
                disabled={submitting}
                style={[styles.option, submitting && styles.disabled]}
                onPress={() => onRespond({ behavior: "allow", action: option.action })}
              >
                <Text style={styles.optionText} numberOfLines={2} ellipsizeMode="tail">
                  {remoteSafeLabel(option.label)}
                </Text>
              </Pressable>
            ))}
          </View>
          <View testID="approval-actions" style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="거부"
              disabled={submitting}
              style={[styles.button, styles.denyButton, submitting && styles.disabled]}
              onPress={() => onRespond({ behavior: "deny" })}
            >
              <Text style={styles.denyText} numberOfLines={1} ellipsizeMode="tail">
                취소
              </Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View testID="approval-actions" style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="거부"
            disabled={submitting}
            style={[styles.button, styles.denyButton, submitting && styles.disabled]}
            onPress={() => onRespond({ behavior: "deny" })}
          >
            <Text style={styles.denyText} numberOfLines={1} ellipsizeMode="tail">
              거부
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="승인"
            disabled={submitting}
            style={[styles.button, styles.allowButton, submitting && styles.disabled]}
            onPress={() => onRespond({ behavior: "allow" })}
          >
            <Text style={styles.allowText} numberOfLines={1} ellipsizeMode="tail">
              {submitting ? "처리 중" : "승인"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** The request's controls in the host modal the approval panel opens. */
export function ApprovalRequestModal({
  open,
  onOpenChange,
  ...body
}: ApprovalRequestModalProps): React.JSX.Element {
  const styles = createStyles(body.theme, body.layout.compact, Dimensions.get("window").width);

  return (
    <Modal title={modalTitle(body.request.method)} open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={styles.content}>{ApprovalRequestBody(body)}</Modal.Content>
    </Modal>
  );
}

export interface ApprovalPopupProps {
  agentId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
}

export interface ApprovalExchange {
  request: PendingApprovalRequest | undefined;
  answer: string;
  submitting: boolean;
  /** What to say when there is no request to show. */
  statusText: string;
  failed: boolean;
  setAnswer(value: string): void;
  respond(response: ApprovalResponse): Promise<void>;
}

/**
 * The live request for one agent plus the state of answering it.
 *
 * Shared by every entry point so a request answered from the composer pill and
 * the same request answered from the approval panel run identical code; only
 * the chrome around the controls differs.
 */
export function useApprovalExchange(
  agentId: string | null,
  active: boolean,
  onResolved: () => void,
): ApprovalExchange {
  const query = usePendingApprovalQuery(agentId, active);
  const submitRpc = useRpc(submitApprovalResponseRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const request = query.data?.requests[0];
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAnswer("");
    setSubmitting(false);
  }, [active, request?.id]);

  const submit = useMemo(
    () =>
      request && agentId !== null
        ? createApprovalSubmitter({
            agentId,
            requestId: request.id,
            submitRpc,
            onSubmitted: () => {
              onResolved();
              void queryClient.invalidateQueries({ queryKey: queryKey(agentId) });
            },
          })
        : null,
    [agentId, onResolved, queryClient, request?.id, submitRpc],
  );

  const respond = useCallback(
    async (response: ApprovalResponse): Promise<void> => {
      if (!submit) return;
      setSubmitting(true);
      try {
        await submit(response);
      } catch (error) {
        setSubmitting(false);
        toast.error(error instanceof Error ? error.message : "OmO 요청 응답을 전송하지 못했습니다.");
      }
    },
    [submit, toast],
  );

  return {
    request,
    answer,
    submitting,
    failed: query.isError,
    statusText: query.isError
      ? query.error instanceof Error
        ? remoteSafeLabel(query.error.message)
        : "OmO 요청을 불러오지 못했습니다."
      : query.isPending
        ? "대기 중인 OmO 요청을 확인하는 중입니다."
        : "대기 중인 OmO 요청이 없습니다.",
    setAnswer,
    respond,
  };
}

/** RPC-connected popup intended for entry-point contribution wiring. */
export function ApprovalPopup({ agentId, open, onOpenChange, theme, layout }: ApprovalPopupProps): React.JSX.Element {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { request, answer, submitting, failed, statusText, setAnswer, respond } = useApprovalExchange(
    agentId,
    open,
    close,
  );

  if (request) {
    return (
      <ApprovalRequestModal
        open={open}
        request={request}
        answer={answer}
        submitting={submitting}
        theme={theme}
        layout={layout}
        onAnswerChange={setAnswer}
        onOpenChange={onOpenChange}
        onRespond={respond}
      />
    );
  }

  const styles = createStyles(theme, layout.compact, Dimensions.get("window").width);
  return (
    <Modal title="OmO 요청" open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={styles.content}>
        <Text
          style={failed ? styles.error : styles.empty}
          numberOfLines={layout.compact ? 3 : 4}
          ellipsizeMode="tail"
        >
          {statusText}
        </Text>
      </Modal.Content>
    </Modal>
  );
}

export function hasPendingApproval(payload: ListPendingApprovalsPayload | undefined): boolean {
  return (payload?.requests.length ?? 0) > 0;
}
