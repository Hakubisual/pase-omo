import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { listPendingApprovalsRpc } from "../shared/approval.js";
import { ApprovalRequestBody, useApprovalExchange } from "./approval.js";
import { isOmoAgent, listedAgents } from "./dag-pill.js";
import { POPOVER_BOTTOM_INSET, popoverMaxHeight } from "./popover-layout.js";

/** Matches the DAG pill: coalesce the burst of agent updates into one refresh. */
const COALESCE_MS = 250;

/**
 * The composer pill's label.
 *
 * The pill stays on screen with the idle label instead of hiding itself: the
 * approval panel it replaces was reachable only from the command center, so a
 * user who did not already know the panel existed had nothing to press when
 * OmO stopped to ask something.
 */
export function approvalPillLabel(pending: number): string {
  if (pending <= 0) return "승인";
  return pending === 1 ? "응답 필요" : `응답 필요 ${pending}`;
}

/**
 * The pending request for the agent this pill belongs to, rendered in the
 * composer popover so an answer never costs a trip to a panel.
 */
export function ApprovalPillPopover(props: PluginButtonContentProps): React.JSX.Element {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const onResolved = useCallback(() => close(), [close]);
  const { request, answer, submitting, expanded, failed, statusText, setAnswer, toggleExpanded, respond } =
    useApprovalExchange(agentId, true, onResolved);

  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(
    () => ({
      // The popover bounds the sheet; the body shrinks inside it and scrolls its
      // own text, which is what keeps the answer controls above the fold.
      screen: {
        padding: layout.compact ? 12 : 16,
        paddingBottom: (layout.compact ? 12 : 16) + POPOVER_BOTTOM_INSET,
        gap: 10,
        maxHeight: popoverMaxHeight(layout.compact, windowHeight),
      },
      status: { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [failed, theme, layout.compact, windowHeight],
  );

  return (
    <View style={styles.screen}>
      {request
        ? ApprovalRequestBody({
            request,
            answer,
            submitting,
            expanded,
            onToggleExpanded: toggleExpanded,
            theme,
            layout,
            onAnswerChange: setAnswer,
            onRespond: respond,
          })
        : <Text style={styles.status}>{statusText}</Text>}
    </View>
  );
}

/**
 * Per-agent composer pill carrying OmO's pending confirm, select or question.
 *
 * Driven by `agents.subscribe` like the DAG pill, so the label follows agent
 * updates instead of a standing timer. A refresh that throws keeps the labels
 * it already published rather than claiming nothing is pending.
 */
export function contributeApprovalPill(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;

  const sync = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const agents = listedAgents(await client.paseo.agents.list());
      if (disposed) return;
      const seen = new Set<string>();

      for (const agent of agents) {
        const { workspaceId } = agent;
        if (!workspaceId || !isOmoAgent(agent)) continue;
        seen.add(agent.id);

        let pill = pills.get(agent.id);
        if (!pill) {
          pill = client.addComposerPill({
            id: "approval",
            workspaceId,
            agentId: agent.id,
            button: {
              title: "OmO 승인",
              icon: "ShieldCheck",
              label: approvalPillLabel(0),
              behavior: { kind: "popover", Content: ApprovalPillPopover },
            },
          });
          pills.set(agent.id, pill);
        }

        const { requests } = await client.rpc(listPendingApprovalsRpc, { agentId: agent.id });
        if (disposed) return;
        pill.update({ label: approvalPillLabel(requests.length) });
      }

      for (const [agentId, pill] of pills) {
        if (seen.has(agentId)) continue;
        pill.remove();
        pills.delete(agentId);
      }
    } catch (error) {
      console.error("[omo-approval] pill refresh failed", error);
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        schedule();
      }
    }
  };

  function schedule(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, COALESCE_MS);
  }

  const unsubscribe = client.paseo.agents.subscribe(() => {
    schedule();
  });

  void sync();

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
