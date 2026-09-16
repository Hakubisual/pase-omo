import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ApprovalPopup, useHasPendingApproval } from "./approval.js";

function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    panel: { flex: 1, padding: compact ? 12 : 16, gap: 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" },
    body: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    // 44pt is the smallest target a thumb hits reliably, which is the whole
    // point of answering a prompt from a phone.
    button: {
      minHeight: 44,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      backgroundColor: theme.colors.accent,
    },
    buttonIdle: { backgroundColor: theme.colors.surface2 },
    buttonLabel: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" },
    buttonLabelIdle: { color: theme.colors.foregroundMuted, fontSize: 14, fontWeight: "600" },
    badge: {
      alignSelf: "flex-start",
      color: theme.colors.accentForeground,
      backgroundColor: theme.colors.accent,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 3,
      fontSize: 12,
      fontWeight: "700",
      overflow: "hidden",
    },
  });
}

/**
 * Agent-side panel that surfaces an OmO request waiting on the user.
 *
 * The popup itself is a host Modal, which has to be opened by something: this
 * panel is that something, and it opens itself the moment a request appears so
 * a prompt is never missed on a phone where no pill is visible.
 */
export function ApprovalPanel({ agentId, theme, layout, navigation }: PluginAgentPanelProps) {
  const compact = layout.compact;
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  // Older hosts expose no navigation, and the "View in session" affordance is
  // hidden rather than dead when they do not.
  const pending = useHasPendingApproval(agentId);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending]);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>OmO Approvals</Text>
      {pending ? <Text style={styles.badge}>Waiting</Text> : null}
      <Text style={styles.body}>
        {pending
          ? "OmO is waiting for a confirmation, choice, or answer."
          : "No pending requests. This view opens the moment one arrives."}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open OmO request"
        disabled={!pending}
        onPress={() => setOpen(true)}
        style={[styles.button, pending ? null : styles.buttonIdle]}
      >
        <Text style={pending ? styles.buttonLabel : styles.buttonLabelIdle}>
          {pending ? "Open request" : "No pending requests"}
        </Text>
      </Pressable>

      <ApprovalPopup
        agentId={agentId}
        open={open}
        onOpenChange={setOpen}
        theme={theme}
        layout={layout}
        {...(navigation === undefined
          ? {}
          : { onViewInSession: () => navigation.openAgent({ agentId }) })}
      />
    </View>
  );
}
