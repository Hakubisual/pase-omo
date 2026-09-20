import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
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
    content: { width: "100%", maxWidth, alignSelf: "center", overflow: "hidden", flexShrink: 1 },
    body: {
      width: "100%",
      maxWidth,
      alignSelf: "center",
      overflow: "hidden",
      flexShrink: 1,
      gap: compact ? 12 : 16,
    },
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
    // The request text and its options scroll; the actions below do not, which
    // is what keeps the send button on screen no matter how long the request is
    // or how much of the screen the keyboard takes.
    scroll: { width: "100%", maxWidth: "100%", flexShrink: 1 },
    scrollContent: { width: "100%", maxWidth: "100%", gap: compact ? 12 : 16, paddingBottom: 4 },
    secondaryRow: {
      width: "100%",
      maxWidth: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    secondaryButton: {
      minHeight: 44,
      flexGrow: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 12,
      borderWidth: 1,
      borderRadius: 8,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    secondaryText: {
      maxWidth: "100%",
      flexShrink: 1,
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: "600",
      textAlign: "center",
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
    selectedOption: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
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

type StructuredApprovalResponse = Extract<ApprovalResponse, { answers: unknown }>;

/** One controlled draft shared by the modal and composer popover entry points. */
export type ApprovalDraft = string | {
  answers: StructuredApprovalResponse["answers"];
  comment: string;
};

export interface ApprovalRequestModalProps {
  open: boolean;
  request: PendingApprovalRequest;
  answer: ApprovalDraft;
  submitting: boolean;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  /** Opens the conversation this request came from. Absent on hosts without navigation. */
  onViewInSession?: () => void;
  onAnswerChange(value: ApprovalDraft): void;
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
  onViewInSession,
  onAnswerChange,
  onRespond,
}: ApprovalRequestBodyProps): React.JSX.Element {
  const styles = createStyles(theme, layout.compact, Dimensions.get("window").width);
  const questions = request.method === "question" ? request.questions : undefined;
  const draft = typeof answer === "string" ? { answers: {}, comment: "" } : answer;
  const legacyAnswer = typeof answer === "string" ? answer : "";
  const answers = Object.fromEntries(
    (questions ?? []).flatMap((question) => {
      const value = draft.answers[question.id];
      if (!value || (value.selected.length === 0 && !value.text?.trim())) return [];
      return [[question.id, {
        selected: value.selected,
        ...(value.text?.trim() ? { text: value.text } : {}),
      }]];
    }),
  );
  const answerReady = questions
    ? Object.keys(answers).length > 0 || draft.comment.trim().length > 0
    : legacyAnswer.trim().length > 0;
  const updateQuestion = (id: string, value: StructuredApprovalResponse["answers"][string]) =>
    onAnswerChange({ ...draft, answers: { ...draft.answers, [id]: value } });
  const displayTitle = remoteSafeLabel(request.title);
  // Nothing is clipped: the request and its options own a scroller of their own
  // and the answer controls sit outside it, so a long question costs scrolling
  // rather than the tail of the sentence you have to answer.

  const option = (entry: { action: string; label: string }): React.JSX.Element => (
    <Pressable
      key={entry.action}
      accessibilityRole="button"
      accessibilityLabel={`${remoteSafeLabel(entry.label)} 선택`}
      disabled={submitting}
      style={[styles.option, submitting && styles.disabled]}
      onPress={() => onRespond({ behavior: "allow", action: entry.action })}
    >
      <Text style={styles.optionText}>{remoteSafeLabel(entry.label)}</Text>
    </Pressable>
  );

  return (
    <View testID="approval-body" style={styles.body}>
      <ScrollView
        testID="approval-scroll"
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{displayTitle}</Text>

        {questions ? (
          <>
            {questions.map((question) => {
              const value = draft.answers[question.id] ?? { selected: [] };
              const heading = remoteSafeLabel(question.header || question.question);
              return (
                <View key={question.id} testID={`approval-question-${question.id}`} style={styles.optionList}>
                  <Text style={styles.title}>{heading}</Text>
                  <Text style={styles.optionText}>{remoteSafeLabel(question.question)}</Text>
                  {question.options.length > 0 ? (
                    <Text style={styles.hint}>{question.multiSelect ? "여러 항목 선택 가능" : "한 항목 선택"}</Text>
                  ) : null}
                  {question.options.map((entry) => {
                    const checked = value.selected.includes(entry.label);
                    return (
                      <Pressable
                        key={entry.label}
                        accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                        accessibilityLabel={`${heading}: ${remoteSafeLabel(entry.label)} 선택`}
                        accessibilityState={{ checked, disabled: submitting }}
                        disabled={submitting}
                        style={[styles.option, checked && styles.selectedOption, submitting && styles.disabled]}
                        onPress={() => updateQuestion(question.id, {
                          ...value,
                          selected: checked
                            ? value.selected.filter((label) => label !== entry.label)
                            : question.multiSelect ? [...value.selected, entry.label] : [entry.label],
                        })}
                      >
                        <Text style={styles.optionText}>{checked ? "✓ " : ""}{remoteSafeLabel(entry.label)}</Text>
                        {entry.description ? <Text style={styles.hint}>{remoteSafeLabel(entry.description)}</Text> : null}
                      </Pressable>
                    );
                  })}
                  <TextInput
                    accessibilityLabel={`${heading} 답변 입력`}
                    value={value.text ?? ""}
                    editable={!submitting}
                    multiline
                    placeholder="답변을 입력하세요"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={styles.input}
                    onChangeText={(text) => updateQuestion(question.id, { ...value, text })}
                  />
                </View>
              );
            })}
            <TextInput
              accessibilityLabel="추가 의견 입력"
              value={draft.comment}
              editable={!submitting}
              multiline
              placeholder="추가 의견 (선택 사항)"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              onChangeText={(comment) => onAnswerChange({ ...draft, comment })}
            />
          </>
        ) : request.method === "question" ? (
          <>
            {request.options.length > 0 ? (
              <View style={styles.optionList}>
                <Text style={styles.hint} numberOfLines={1} ellipsizeMode="tail">
                  추천 답변
                </Text>
                {request.options.map(option)}
              </View>
            ) : null}
            <TextInput
              accessibilityLabel="답변 입력"
              value={legacyAnswer}
              editable={!submitting}
              multiline
              placeholder="답변을 입력하세요"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              onChangeText={onAnswerChange}
            />
          </>
        ) : request.method === "select" ? (
          <View style={styles.optionList}>{request.options.map(option)}</View>
        ) : null}
      </ScrollView>

      {onViewInSession === undefined ? null : (
        <View testID="approval-secondary" style={styles.secondaryRow}>
          {onViewInSession === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="세션에서 보기"
              style={styles.secondaryButton}
              onPress={onViewInSession}
            >
              <Text style={styles.secondaryText} numberOfLines={1} ellipsizeMode="tail">
                세션에서 보기
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {request.method === "question" ? (
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
            onPress={() => onRespond(questions
              ? { behavior: "allow", answers, ...(draft.comment.trim() ? { comment: draft.comment } : {}) }
              : { behavior: "allow", answer: legacyAnswer.trim() })}
          >
            <Text style={styles.allowText} numberOfLines={1} ellipsizeMode="tail">
              {submitting ? "전송 중" : "답변 보내기"}
            </Text>
          </Pressable>
        </View>
      ) : request.method === "select" ? (
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
      {/* The body owns its own scrolling so the actions can stay outside it. */}
      <Modal.Content scrollable={false} contentContainerStyle={styles.content}>
        {ApprovalRequestBody(body)}
      </Modal.Content>
    </Modal>
  );
}

export interface ApprovalPopupProps {
  agentId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  /** Opens the conversation the request came from; omitted on hosts without navigation. */
  onViewInSession?: () => void;
}

export interface ApprovalExchange {
  request: PendingApprovalRequest | undefined;
  answer: ApprovalDraft;
  submitting: boolean;
  /** What to say when there is no request to show. */
  statusText: string;
  failed: boolean;
  setAnswer(value: ApprovalDraft): void;
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
  const [answer, setAnswer] = useState<ApprovalDraft>("");
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
export function ApprovalPopup({
  agentId,
  open,
  onOpenChange,
  theme,
  layout,
  onViewInSession,
}: ApprovalPopupProps): React.JSX.Element {
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
        {...(onViewInSession === undefined ? {} : { onViewInSession })}
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
