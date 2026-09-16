import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { openInDagDashboard, type DagNavigationRequest } from "./dag-navigation.js";

/**
 * "Open in OmO DAG" for a chat card, a pill popover or a task row.
 *
 * Following a run used to mean opening the dashboard and finding the session
 * again in a list that reorders itself while work is happening. This carries the
 * destination instead, and reports a destination it could not resolve rather
 * than opening whatever session happens to be first.
 */
export function OpenInDagButton({
  request,
  theme,
  compact,
  label = "OmO DAG에서 열기",
}: {
  request: DagNavigationRequest;
  theme: PluginTheme;
  compact: boolean;
  label?: string;
}): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onPress = (): void => {
    setBusy(true);
    setMessage(null);
    void openInDagDashboard(request)
      .then((result) => setMessage(result.reason ?? null))
      .catch((error: unknown) => setMessage(String((error as Error)?.message ?? error)))
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.wrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: theme.colors.surface2,
            borderColor: theme.colors.border,
            opacity: pressed || busy ? 0.7 : 1,
          },
        ]}
      >
        <Text
          style={[styles.label, { color: theme.colors.foreground, fontSize: compact ? 12 : 13 }]}
          numberOfLines={1}
        >
          {busy ? "여는 중…" : label}
        </Text>
      </Pressable>
      {message === null ? null : (
        <Text style={[styles.message, { color: theme.colors.statusWarning }]}>{message}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 4 },
  button: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  label: { fontWeight: "600" },
  message: { fontSize: 11 },
});
