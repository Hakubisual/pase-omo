import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { activeRunsRpc } from "../shared/row";
import { DagGraph } from "./graph";

/** Live refresh cadence while the sheet is open. */
const REFRESH_MS = 1500;

export function DagPillPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const fetchRuns = useRpc(activeRunsRpc);

  const query = useQuery({
    queryKey: ["omo-dag-chat", "active", agentId],
    enabled: agentId !== null,
    refetchInterval: REFRESH_MS,
    queryFn: () => fetchRuns({ agentId: agentId as string }),
  });

  const styles = useMemo(
    () => ({
      screen: { padding: layout.compact ? 12 : 16, gap: 10, maxHeight: layout.compact ? 420 : 520 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const rows = query.data?.rows ?? [];

  return (
    <ScrollView style={{ maxHeight: styles.screen.maxHeight }} contentContainerStyle={styles.screen}>
      {rows.length === 0 ? (
        <Text style={styles.empty}>
          {query.isPending ? "Loading DAG runs…" : "No DAG runs in the last 6 hours."}
        </Text>
      ) : (
        rows
          .slice()
          .reverse()
          .map((row) => (
            <View key={row.runId}>
              <DagGraph row={row} theme={theme} compact={layout.compact} agentId={agentId ?? undefined} />
            </View>
          ))
      )}
    </ScrollView>
  );
}
