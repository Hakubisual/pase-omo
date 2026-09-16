import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { DagRunNode, DagTask } from "../shared/dag";
import { agentDagSnapshotRpc, type DagRow } from "../shared/row";
import { formatDuration, formatKoreanDateTime } from "./dag";
import { COMPACT_GRAPH_METRICS, DEFAULT_GRAPH_METRICS, layoutGraph, type GraphNode } from "./graph-layout";
import { OpenInDagButton } from "./open-in-dag";
import {
  edgeVisual,
  fitsStateLine,
  graphTypography,
  nodeTransition,
  nodeVisual,
  progressPercent,
  statusLabel,
  type GraphTypography,
} from "./graph-visual";

export { statusLabel, stateColor } from "./graph-visual";

/** Size of the chevron drawn at each arrow's head. */
const ARROW = 6;

function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: compact ? 12 : 16,
      gap: compact ? 8 : 10,
    },
    header: { flexDirection: "row", alignItems: "center", gap: 8 },
    badge: {
      color: theme.colors.foregroundMuted,
      backgroundColor: theme.colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      fontSize: 11,
    },
    title: { flex: 1, color: theme.colors.foreground, fontWeight: "600", fontSize: compact ? 14 : 15 },
    counter: { color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
    track: { height: 4, borderRadius: 999, backgroundColor: theme.colors.surface2, overflow: "hidden" },
    fill: { height: 4, borderRadius: 999 },
    canvas: { position: "relative" },
    node: { position: "absolute" },
    nodeBody: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      paddingHorizontal: 4,
      paddingVertical: 3,
      // Centred rather than stacked from the top: a scaled-down box has room for
      // one line and a margin, and text pinned to the top of it reads as
      // clipped even when it is not.
      alignItems: "center",
      justifyContent: "center",
      gap: 1,
      overflow: "hidden",
    },
    nodeHead: { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: "100%" },
    nodeGlyph: { fontWeight: "700" },
    nodeLabel: { flexShrink: 1, fontWeight: "600", textAlign: "center" },
    nodeState: { textAlign: "center" },
    edge: { position: "absolute", borderRadius: 999 },
    arrow: { position: "absolute", width: ARROW, height: ARROW },
    empty: { color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 4 },
    footer: { color: theme.colors.foregroundMuted, fontSize: 11 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 11 },

    inspector: {
      backgroundColor: theme.colors.surface0,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      gap: 8,
    },
    inspectorHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    inspectorTitleGroup: { flex: 1, gap: 2 },
    inspectorTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    inspectorSub: { color: theme.colors.foregroundMuted, fontSize: 11 },
    inspectorClose: { paddingHorizontal: 6, paddingVertical: 2 },
    inspectorCloseText: { color: theme.colors.foregroundMuted, fontSize: 12 },
    errorBox: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.statusDanger,
      borderWidth: 1,
      borderRadius: 8,
      padding: 8,
      gap: 3,
    },
    errorTitle: { color: theme.colors.statusDanger, fontSize: 11, fontWeight: "700" },
    errorText: { color: theme.colors.foreground, fontSize: 12 },
    detailGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    detailItem: { gap: 2 },
    detailGridItem: { minWidth: "44%", flexGrow: 1, gap: 2 },
    detailLabel: { color: theme.colors.foregroundMuted, fontSize: 10 },
    detailValue: { color: theme.colors.foreground, fontSize: 12 },
    progressBox: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 8,
      gap: 3,
    },
    progressLabel: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" },
    progressText: { color: theme.colors.foreground, fontSize: 12 },
    taskIdFooter: { color: theme.colors.foregroundMuted, fontSize: 10 },
  });
}

/**
 * One node, which plays the transition its state change describes.
 *
 * The animated values live per node so a single step turning green animates
 * itself alone; a shared value would replay the whole graph on every update.
 */
function GraphNodeCard({
  node,
  theme,
  styles,
  type,
  selected,
  onPress,
}: {
  node: GraphNode;
  theme: PluginTheme;
  styles: ReturnType<typeof createStyles>;
  type: GraphTypography;
  selected: boolean;
  onPress: () => void;
}) {
  const visual = nodeVisual(node.state, theme);
  const previous = useRef<string | undefined>(undefined);
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const transition = nodeTransition(previous.current, node.state);
    previous.current = node.state;
    if (!transition.animate) return;

    opacity.setValue(transition.from.opacity);
    scale.setValue(transition.from.scale);
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue: transition.to.opacity,
        duration: transition.durationMs,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: transition.to.scale,
        duration: transition.durationMs,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [node.state, opacity, scale]);

  const showState = fitsStateLine(node.height, type);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`노드 ${node.label}, ${visual.label}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.node,
        { left: node.x, top: node.y, width: node.width, height: node.height, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Animated.View
        style={[
          styles.nodeBody,
          {
            borderColor: selected ? theme.colors.accent : visual.borderColor,
            backgroundColor: selected ? theme.colors.surface2 : visual.backgroundColor,
            borderWidth: selected ? 2 : visual.lit ? 1.5 : 1,
            opacity,
            transform: [{ scale }],
          },
        ]}
      >
        <View style={styles.nodeHead}>
          {visual.glyph === "" ? null : (
            <Text style={[styles.nodeGlyph, { fontSize: type.glyph, color: visual.borderColor }]}>
              {visual.glyph}
            </Text>
          )}
          <Text
            style={[
              styles.nodeLabel,
              { fontSize: type.label, lineHeight: Math.round(type.label * 1.3), color: visual.labelColor },
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {node.label}
          </Text>
        </View>
        {showState ? (
          <Text
            style={[
              styles.nodeState,
              {
                fontSize: type.state,
                lineHeight: Math.round(type.state * 1.3),
                color: visual.lit ? theme.colors.accent : theme.colors.foregroundMuted,
              },
            ]}
            numberOfLines={1}
          >
            {visual.label}
          </Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

/** What the inspector knows about the selected node beyond the row itself. */
type NodeDetail = { node: DagRunNode; task: DagTask | undefined };

/**
 * Pulls the run record behind the selected node.
 *
 * The chat row carries only what it draws - id, label, state - so the fields
 * the panel shows (attempt, error, model, timings) have to come from the same
 * snapshot RPC the panel reads. It is fetched on selection rather than with the
 * row: a chat full of DAG cards must not each hold a live query open.
 */
function useNodeDetail(input: {
  agentId: string | undefined;
  runId: string;
  nodeId: string | null;
  updatedAt: string;
}): NodeDetail | null {
  const { agentId, runId, nodeId, updatedAt } = input;
  const fetchSnapshot = useRpc(agentDagSnapshotRpc);
  // The RPC binding is re-created per render by the host; kept in a ref it stays
  // out of the effect's dependencies, where it would refetch on every render.
  const fetchRef = useRef(fetchSnapshot);
  fetchRef.current = fetchSnapshot;

  const [detail, setDetail] = useState<NodeDetail | null>(null);

  useEffect(() => {
    if (agentId === undefined || nodeId === null) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchRef.current({ agentId });
        if (cancelled) return;
        const run = payload.runs.find((candidate) => candidate.id === runId);
        const node = run?.nodes.find((candidate) => candidate.id === nodeId);
        setDetail(
          node === undefined
            ? null
            : { node, task: payload.tasks.find((candidate) => candidate.id === node.taskId) },
        );
      } catch {
        // A host without the RPC bound still gets the inspector; it just shows
        // what the row itself knows instead of failing the whole card.
        if (!cancelled) setDetail(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `updatedAt` re-reads the snapshot as the run moves, so an open inspector
    // on a running node keeps up instead of freezing at its first read.
  }, [agentId, nodeId, runId, updatedAt]);

  return detail;
}

function DetailField({
  label,
  value,
  styles,
  wide,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
  wide?: boolean;
}) {
  return (
    <View style={wide === true ? styles.detailItem : styles.detailGridItem}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/**
 * The panel's node inspector, in the space a chat row has.
 *
 * Same fields and same labels as the workspace panel, because the point of
 * tapping a node on a phone is to get the answer the desktop gives rather than
 * a smaller different one.
 */
function NodeInspector({
  row,
  nodeId,
  detail,
  theme,
  styles,
  onClose,
}: {
  row: DagRow;
  nodeId: string;
  detail: NodeDetail | null;
  theme: PluginTheme;
  styles: ReturnType<typeof createStyles>;
  onClose: () => void;
}) {
  const chips = useMemo(() => row.layers.flat(), [row.layers]);
  const chip = chips.find((candidate) => candidate.id === nodeId);
  const labelOf = (id: string): string => chips.find((candidate) => candidate.id === id)?.label ?? id;

  const wave = row.layers.findIndex((layer) => layer.some((candidate) => candidate.id === nodeId));
  const upstream = row.edges.filter((edge) => edge.to === nodeId).map((edge) => labelOf(edge.from));
  const downstream = row.edges.filter((edge) => edge.from === nodeId).map((edge) => labelOf(edge.to));

  const task = detail?.task;
  const attempt = detail?.node.attempt ?? 0;

  return (
    <View style={styles.inspector}>
      <View style={styles.inspectorHeader}>
        <View style={styles.inspectorTitleGroup}>
          <Text style={styles.inspectorTitle} numberOfLines={1} ellipsizeMode="tail">
            노드 상세: {chip?.label ?? nodeId}
          </Text>
          <Text style={styles.inspectorSub} numberOfLines={1} ellipsizeMode="tail">
            {nodeId}
            {attempt > 0 ? ` · 시도 ${attempt + 1}` : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="상세 닫기"
          onPress={onClose}
          style={styles.inspectorClose}
        >
          <Text style={styles.inspectorCloseText}>✕ 닫기</Text>
        </Pressable>
      </View>

      {detail?.node.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>오류 발생</Text>
          <Text style={styles.errorText}>{detail.node.error}</Text>
        </View>
      ) : null}

      {task?.description ? (
        <DetailField label="설명" value={task.description} styles={styles} wide />
      ) : null}

      <View style={styles.detailGrid}>
        <View style={styles.detailGridItem}>
          <Text style={styles.detailLabel}>상태</Text>
          <Text style={[styles.detailValue, { color: nodeVisual(chip?.state ?? "pending", theme).borderColor }]}>
            {statusLabel(chip?.state ?? "pending")}
          </Text>
        </View>
        {wave >= 0 ? <DetailField label="웨이브" value={`${wave + 1}단계`} styles={styles} /> : null}
        {task?.agent ? <DetailField label="에이전트" value={task.agent} styles={styles} /> : null}
        {task?.model ? <DetailField label="모델" value={task.model} styles={styles} /> : null}
        {task?.turns !== undefined ? (
          <DetailField label="턴" value={`${task.turns}턴`} styles={styles} />
        ) : null}
        {task?.toolCalls !== undefined ? (
          <DetailField label="도구 호출" value={`${task.toolCalls}회`} styles={styles} />
        ) : null}
        {task?.startedAt ? (
          <DetailField
            label="경과 시간"
            value={formatDuration(task.startedAt, task.completedAt)}
            styles={styles}
          />
        ) : null}
        {task?.startedAt ? (
          <DetailField label="시작 시각" value={formatKoreanDateTime(task.startedAt)} styles={styles} />
        ) : null}
      </View>

      {upstream.length > 0 ? (
        <DetailField label="선행 노드" value={upstream.join(", ")} styles={styles} wide />
      ) : null}
      {downstream.length > 0 ? (
        <DetailField label="후행 노드" value={downstream.join(", ")} styles={styles} wide />
      ) : null}

      {task?.progress ? (
        <View style={styles.progressBox}>
          <Text style={styles.progressLabel}>진행 상황</Text>
          <Text style={styles.progressText}>{task.progress}</Text>
        </View>
      ) : null}

      {detail?.node.taskId ? (
        <Text style={styles.taskIdFooter}>연결된 태스크 ID: {detail.node.taskId}</Text>
      ) : null}
    </View>
  );
}

/**
 * One DAG run drawn as a graph: dependency layers left to right, real arrows
 * between the nodes that actually depend on one another, and the running node
 * lit so a live step is findable without reading any text.
 *
 * Nodes are tappable and open the same inspector the workspace panel shows,
 * which is what makes the card on a phone the whole surface rather than a
 * preview of one.
 */
export function DagGraph({
  row,
  theme,
  compact,
  agentId,
  navigable = false,
}: {
  row: DagRow;
  theme: PluginTheme;
  compact: boolean;
  /** Unlocks the run-record fields of the inspector; the graph draws without it. */
  agentId?: string | undefined;
  /** Draws "Open in OmO DAG" for this run. Needs an agent to resolve its owner. */
  navigable?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const metrics = compact ? COMPACT_GRAPH_METRICS : DEFAULT_GRAPH_METRICS;
  // The graph is centred inside the box it is actually given, so it has to know
  // that box: until the first layout pass reports one, it draws at its natural
  // size rather than guessing a width and jumping afterwards.
  const [boxWidth, setBoxWidth] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = useMemo(
    () =>
      layoutGraph(
        { layers: row.layers, edges: row.edges },
        metrics,
        boxWidth > 0 ? { width: boxWidth } : undefined,
      ),
    [row.layers, row.edges, metrics, boxWidth],
  );

  const type = useMemo(() => graphTypography(layout.scale, compact), [layout.scale, compact]);
  const detail = useNodeDetail({
    agentId,
    runId: row.runId,
    nodeId: selectedId,
    updatedAt: row.updatedAt,
  });

  // A run that dropped the selected node - truncation, a new generation - must
  // not hold an inspector open on something the graph no longer draws.
  const selectedExists = layout.nodes.some((node) => node.id === selectedId);

  const percent = progressPercent(row);
  const barColor =
    row.failed > 0 ? theme.colors.statusDanger : row.running > 0 ? theme.colors.accent : theme.colors.statusSuccess;

  const footer = [
    statusLabel(row.status),
    row.running > 0 ? `실행 중 ${row.running}` : null,
    row.failed > 0 ? `실패 ${row.failed}` : null,
    row.truncated ? "일부 노드 생략" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.badge}>DAG</Text>
        <Text style={styles.title} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.counter}>
          {row.completed}/{row.total}
        </Text>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` as ViewStyle["width"], backgroundColor: barColor }]} />
      </View>

      {navigable && agentId !== undefined ? (
        <OpenInDagButton request={{ agentId, runId: row.runId }} theme={theme} compact={compact} />
      ) : null}

      {layout.nodes.length === 0 ? (
        <Text style={styles.empty}>표시할 노드가 없습니다</Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          onLayout={(event) => {
            const width = Math.round(event.nativeEvent.layout.width);
            // Only a real change matters: re-setting the same width would relayout
            // the graph on every scroll frame.
            if (width > 0 && width !== boxWidth) setBoxWidth(width);
          }}
        >
          <View style={[styles.canvas, { width: layout.width, height: layout.height }]}>
            {layout.edges.map((edge) => {
              const visual = edgeVisual(edge.fulfilled, theme);
              const radians = (edge.angle * Math.PI) / 180;
              // The strip is rotated about its centre, so the head sits half a
              // length along the edge direction from that centre.
              const headX = edge.x + edge.length / 2 + (edge.length / 2) * Math.cos(radians);
              const headY = edge.y + (edge.length / 2) * Math.sin(radians);
              return (
                <View key={`${edge.from}->${edge.to}`}>
                  <View
                    style={[
                      styles.edge,
                      {
                        left: edge.x,
                        top: edge.y - visual.thickness / 2,
                        width: edge.length,
                        height: visual.thickness,
                        backgroundColor: visual.color,
                        transform: [{ rotate: `${edge.angle}deg` }],
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.arrow,
                      {
                        left: headX - ARROW / 2,
                        top: headY - ARROW / 2,
                        borderTopWidth: visual.thickness,
                        borderRightWidth: visual.thickness,
                        borderColor: visual.color,
                        // A square showing only its top and right edges points
                        // up-right; the extra 45 degrees aims it along the edge.
                        transform: [{ rotate: `${edge.angle + 45}deg` }],
                      },
                    ]}
                  />
                </View>
              );
            })}

            {layout.nodes.map((node) => (
              <GraphNodeCard
                key={node.id}
                node={node}
                theme={theme}
                styles={styles}
                type={type}
                selected={node.id === selectedId}
                onPress={() => setSelectedId((current) => (current === node.id ? null : node.id))}
              />
            ))}
          </View>
        </ScrollView>
      )}

      {selectedId !== null && selectedExists ? (
        <NodeInspector
          row={row}
          nodeId={selectedId}
          detail={detail}
          theme={theme}
          styles={styles}
          onClose={() => setSelectedId(null)}
        />
      ) : layout.nodes.length > 0 ? (
        <Text style={styles.hint}>노드를 누르면 상세 정보가 표시됩니다</Text>
      ) : null}

      <Text style={styles.footer}>{footer}</Text>
    </View>
  );
}
