import type { PluginTheme } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import type { DagRun, DagTask } from "../shared/dag.js";
import { stateColor, statusLabel } from "./graph-visual.js";
import {
  COMPACT_WORKFLOW_METRICS,
  WORKFLOW_METRICS,
  layoutWorkflow,
  relativeTime,
  shortDuration,
  taskElapsed,
  workflowActivity,
  type EdgeTone,
  type FlowPath,
} from "./workflow-layout.js";

export interface WorkflowBoardProps {
  run: DagRun;
  tasksMap: Map<string, DagTask>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  /** Work spawned under this run plus the session's run-less tasks, for the side drawer. */
  subtasks: DagTask[];
  theme: PluginTheme;
  compact: boolean;
}

const EDGE_THICKNESS = 1.5;
const FLOW_DOT = 5;
const FLOW_PHASES = [0, 1 / 3, 2 / 3];
const FLOW_MS = 1600;
const DRAWER_WIDTH = 248;
const TASK_LABELS: Record<string, string> = { error: "Error", interrupted: "Interrupted", lost: "Lost" };

const linear = (t: number) => t;

function taskLabel(status: string | undefined): string {
  if (status === undefined) return "Unknown";
  return TASK_LABELS[status] ?? statusLabel(status);
}

function FlowDots({ path, progress, color }: { path: FlowPath; progress: Animated.Value; color: string }) {
  if (path.xs.length < 2) return null;
  const half = FLOW_DOT / 2;
  return (
    <>
      {FLOW_PHASES.map((phase) => {
        const t = phase === 0 ? progress : Animated.modulo(Animated.add(progress, phase), 1);
        return (
          <Animated.View
            key={phase}
            pointerEvents="none"
            style={[
              styles.flowDot,
              {
                backgroundColor: color,
                transform: [
                  { translateX: t.interpolate({ inputRange: path.stops, outputRange: path.xs.map((x) => x - half) }) },
                  { translateY: t.interpolate({ inputRange: path.stops, outputRange: path.ys.map((y) => y - half) }) },
                ],
              },
            ]}
          />
        );
      })}
    </>
  );
}

function edgeColor(tone: EdgeTone, theme: PluginTheme): string {
  if (tone === "done") return theme.colors.statusSuccess;
  if (tone === "active") return theme.colors.accent;
  if (tone === "failed") return theme.colors.statusDanger;
  return theme.colors.border;
}

function formatRate(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(1)} tok/s`;
}

export function WorkflowBoard({
  run,
  tasksMap,
  selectedNodeId,
  onSelectNode,
  subtasks,
  theme,
  compact,
}: WorkflowBoardProps): React.JSX.Element {
  const [viewportWidth, setViewportWidth] = useState(0);
  const [activityOpen, setActivityOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const metrics = compact ? COMPACT_WORKFLOW_METRICS : WORKFLOW_METRICS;
  const layout = useMemo(() => layoutWorkflow(run, metrics, viewportWidth), [run, metrics, viewportWidth]);
  const now = Date.now();
  const activity = workflowActivity(run, tasksMap, now);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = Math.round(event.nativeEvent.layout.width);
      if (width > 0 && width !== viewportWidth) setViewportWidth(width);
    },
    [viewportWidth],
  );

  // One clock drives every flowing edge, and it only ticks while something runs.
  const flowing = layout.edges.some((edge) => edge.tone === "active");
  useEffect(() => {
    if (!flowing) return;
    progress.setValue(0);
    const loop = Animated.loop(
      // Web has no native animated module; its JS fallback stops a native-driven
      // loop after the first pass, which froze the dots at the end of each edge.
      Animated.timing(progress, { toValue: 1, duration: FLOW_MS, easing: linear, useNativeDriver: Platform.OS !== "web" }),
    );
    loop.start();
    return () => loop.stop();
  }, [flowing, progress]);

  const runningSubtasks = subtasks.filter((task) => task.status === "running").length;
  const runColor = stateColor(run.status, theme);
  const selected = selectedNodeId ? run.nodes.find((node) => node.id === selectedNodeId) : undefined;
  const selectedTask = selected?.taskId ? tasksMap.get(selected.taskId) : undefined;

  return (
    <View
      style={[
        styles.board,
        { backgroundColor: theme.colors.surface0, borderColor: run.status === "running" ? theme.colors.accent : theme.colors.border },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: theme.colors.foreground }]} numberOfLines={1} ellipsizeMode="tail">
            {run.name || run.id}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
            {layout.settled}/{layout.total} settled · wave {layout.waves.length === 0 ? 0 : layout.currentWave + 1}/
            {layout.waves.length}
          </Text>
        </View>
        <Text style={[styles.runState, { color: runColor }]}>{statusLabel(run.status)}</Text>
        {subtasks.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open or close the subtask list"
            accessibilityState={{ expanded: drawerOpen }}
            onPress={() => setDrawerOpen((open) => !open)}
            style={[
              styles.drawerToggle,
              {
                borderColor: drawerOpen ? theme.colors.accent : theme.colors.border,
                backgroundColor: drawerOpen ? theme.colors.surface2 : "transparent",
              },
            ]}
          >
            <Text style={[styles.drawerToggleText, { color: theme.colors.foreground }]}>
              Subtasks {subtasks.length}
              {runningSubtasks > 0 ? ` · ${runningSubtasks}` : ""} {drawerOpen ? "▸" : "◂"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.body, compact && styles.bodyCompact]}>
      <View style={styles.main}>
      <View onLayout={handleLayout}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
          <View style={{ width: layout.width, height: layout.height }}>
            {layout.waves.map((wave) => (
              <Text
                key={`wave-${wave.index}`}
                style={[
                  styles.waveHeader,
                  { left: wave.x, top: metrics.padding, width: metrics.cardWidth, color: theme.colors.foregroundMuted },
                ]}
                numberOfLines={1}
              >
                Wave {wave.index + 1} · {wave.settled}/{wave.total} settled
                {wave.running > 0 ? ` · ${wave.running} running` : ""}
              </Text>
            ))}

            {layout.edges.map((edge) =>
              edge.pieces.map((piece, index) => (
                  <View
                    key={`edge-${edge.from}-${edge.to}-${index}`}
                    pointerEvents="none"
                    style={[
                      styles.edgePiece,
                      {
                        left: piece.cx - piece.length / 2,
                        top: piece.cy - EDGE_THICKNESS / 2,
                        width: piece.length + 0.6,
                        height: EDGE_THICKNESS,
                        backgroundColor: edgeColor(edge.tone, theme),
                        opacity: edge.tone === "active" ? 0.35 : 1,
                        transform: [{ rotate: `${piece.angle}rad` }],
                      },
                    ]}
                  />
              )),
            )}

            {layout.edges.map((edge) =>
              edge.tone === "active" ? (
                <FlowDots
                  key={`flow-${edge.from}-${edge.to}`}
                  path={edge.path}
                  progress={progress}
                  color={theme.colors.accent}
                />
              ) : null,
            )}

            {layout.cards.map((card) => {
              const { node } = card;
              const task = node.taskId ? tasksMap.get(node.taskId) : undefined;
              const color = stateColor(node.state, theme);
              const isSelected = node.id === selectedNodeId;
              const elapsed = taskElapsed(task, now);
              const statusLine = [
                statusLabel(node.state),
                elapsed === undefined ? undefined : shortDuration(elapsed),
                formatRate(task?.tokensPerSecond),
              ]
                .filter(Boolean)
                .join(" · ");
              const routeLine = [task?.agent, task?.model].filter(Boolean).join(" · ");
              const detailLine =
                node.state === "failed" && node.error
                  ? node.error
                  : node.state === "running"
                    ? (task?.progress ?? task?.description)
                    : task?.description;
              const quiet = node.state === "pending" || node.state === "blocked" || node.state === "scheduled";
              return (
                <Pressable
                  key={node.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Select node: ${node.label}`}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => onSelectNode(isSelected ? null : node.id)}
                  style={({ pressed }) => [
                    styles.card,
                    {
                      left: card.x,
                      top: card.y,
                      width: card.width,
                      height: card.height,
                      backgroundColor: quiet ? "transparent" : theme.colors.surface1,
                      borderColor: isSelected
                        ? theme.colors.accent
                        : node.state === "running"
                          ? `${theme.colors.accent}99`
                          : theme.colors.border,
                      borderWidth: isSelected ? 2 : 1,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View style={styles.cardTitleRow}>
                    <View
                      style={[
                        styles.dot,
                        quiet
                          ? { borderColor: color, borderWidth: 1 }
                          : { backgroundColor: color },
                      ]}
                    />
                    <Text
                      style={[styles.cardTitle, { color: quiet ? theme.colors.foregroundMuted : theme.colors.foreground }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {node.label}
                    </Text>
                  </View>
                  <Text style={[styles.cardLine, { color }]} numberOfLines={1} ellipsizeMode="tail">
                    {statusLine}
                  </Text>
                  {routeLine ? (
                    <Text
                      style={[styles.cardLine, { color: theme.colors.foregroundMuted }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {routeLine}
                    </Text>
                  ) : null}
                  {detailLine ? (
                    <Text
                      style={[styles.cardLine, { color: theme.colors.foregroundMuted }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {detailLine}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {selected ? (
        <View style={[styles.inspector, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }]}>
          <View style={styles.inspectorHeader}>
            <Text style={[styles.inspectorTitle, { color: theme.colors.foreground }]} numberOfLines={1} ellipsizeMode="tail">
              {selected.label}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close node details"
              onPress={() => onSelectNode(null)}
              style={styles.closeButton}
            >
              <Text style={{ color: theme.colors.foregroundMuted }}>Close</Text>
            </Pressable>
          </View>
          <Text style={[styles.inspectorLine, { color: stateColor(selected.state, theme) }]}>
            {statusLabel(selected.state)}
            {selected.attempt > 0 ? ` · attempt ${selected.attempt + 1}` : ""}
            {selectedTask?.turns !== undefined ? ` · ${selectedTask.turns} turns` : ""}
            {selectedTask?.toolCalls !== undefined ? ` · ${selectedTask.toolCalls} tool calls` : ""}
          </Text>
          {selectedTask?.agent || selectedTask?.model ? (
            <Text style={[styles.inspectorLine, { color: theme.colors.foregroundMuted }]}>
              {[selectedTask.agent, selectedTask.model].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          {selectedTask?.description ? (
            <Text style={[styles.inspectorLine, { color: theme.colors.foreground }]}>{selectedTask.description}</Text>
          ) : null}
          {selectedTask?.progress && selectedTask.progress !== selectedTask.description ? (
            <Text style={[styles.inspectorLine, { color: theme.colors.accent }]}>{selectedTask.progress}</Text>
          ) : null}
          {selected.error ? (
            <Text style={[styles.inspectorLine, { color: theme.colors.statusDanger }]}>{selected.error}</Text>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.activity, { borderColor: theme.colors.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Collapse or expand activity"
          accessibilityState={{ expanded: activityOpen }}
          onPress={() => setActivityOpen((open) => !open)}
          style={styles.activityHeader}
        >
          <Text style={[styles.activityTitle, { color: theme.colors.foregroundMuted }]}>Activity</Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{activityOpen ? "▾" : "▸"}</Text>
        </Pressable>
        {activityOpen
          ? activity.length === 0
            ? (
                <Text style={[styles.activityText, { color: theme.colors.foregroundMuted }]}>No activity yet.</Text>
              )
            : activity.map((entry) => (
                <Pressable
                  key={entry.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Activity: ${entry.text}`}
                  onPress={() => onSelectNode(entry.nodeId)}
                  style={styles.activityRow}
                >
                  <Text
                    style={[
                      styles.activityText,
                      { color: entry.state === null ? theme.colors.foregroundMuted : stateColor(entry.state, theme) },
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {entry.state === null ? "  " : "• "}
                    {entry.text}
                    {entry.state === null || entry.state === "running" ? "" : ` — ${statusLabel(entry.state)}`}
                  </Text>
                  <Text style={[styles.activityTime, { color: theme.colors.foregroundMuted }]}>
                    {relativeTime(entry.at, now)}
                  </Text>
                </Pressable>
              ))
          : null}
      </View>
      </View>

      {drawerOpen && subtasks.length > 0 ? (
        <View
          style={[
            compact ? styles.drawerCompact : styles.drawer,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
          ]}
        >
          <Text style={[styles.drawerTitle, { color: theme.colors.foregroundMuted }]}>
            Subtasks {subtasks.length}
          </Text>
          <ScrollView style={compact ? undefined : { maxHeight: Math.max(layout.height, 320) }}>
            {subtasks.map((task) => {
              const color = stateColor(task.status ?? "", theme);
              const elapsed = taskElapsed(task, now);
              const meta = [taskLabel(task.status), elapsed === undefined ? undefined : shortDuration(elapsed), task.agent]
                .filter(Boolean)
                .join(" · ");
              return (
                <View key={task.id} style={[styles.subtask, { borderColor: theme.colors.border }]}>
                  <View style={styles.cardTitleRow}>
                    <View style={[styles.dot, { backgroundColor: color }]} />
                    <Text
                      style={[styles.subtaskTitle, { color: theme.colors.foreground }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {task.description ?? task.id}
                    </Text>
                  </View>
                  <Text style={[styles.cardLine, { color }]} numberOfLines={1} ellipsizeMode="tail">
                    {meta}
                  </Text>
                  {task.status === "running" && task.progress ? (
                    <Text
                      style={[styles.cardLine, { color: theme.colors.foregroundMuted }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {task.progress}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  board: { borderWidth: 1, borderRadius: 10, overflow: "hidden", marginBottom: 12 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, gap: 12 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: "600" },
  subtitle: { fontSize: 12, marginTop: 2 },
  runState: { fontSize: 13, fontWeight: "600" },
  scrollContent: { flexGrow: 1 },
  waveHeader: { position: "absolute", fontSize: 11 },
  edgePiece: { position: "absolute", borderRadius: 1 },
  flowDot: { position: "absolute", left: 0, top: 0, width: FLOW_DOT, height: FLOW_DOT, borderRadius: FLOW_DOT / 2 },
  body: { flexDirection: "row" },
  bodyCompact: { flexDirection: "column" },
  main: { flex: 1, minWidth: 0 },
  drawerToggle: { minHeight: 32, paddingHorizontal: 10, borderWidth: 1, borderRadius: 6, justifyContent: "center" },
  drawerToggleText: { fontSize: 12, fontWeight: "600" },
  drawer: { width: DRAWER_WIDTH, borderLeftWidth: 1, paddingHorizontal: 10, paddingTop: 8 },
  drawerCompact: { borderTopWidth: 1, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8 },
  drawerTitle: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  subtask: { borderBottomWidth: 1, paddingVertical: 7, gap: 2 },
  subtaskTitle: { flex: 1, fontSize: 12, fontWeight: "600" },
  card: { position: "absolute", borderRadius: 6, paddingHorizontal: 9, paddingVertical: 7, gap: 2, overflow: "hidden" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cardTitle: { flex: 1, fontSize: 13, fontWeight: "600" },
  cardLine: { fontSize: 11 },
  inspector: { marginHorizontal: 14, marginBottom: 10, padding: 10, borderWidth: 1, borderRadius: 8, gap: 4 },
  inspectorHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  inspectorTitle: { flex: 1, fontSize: 14, fontWeight: "600" },
  inspectorLine: { fontSize: 12 },
  closeButton: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  activity: { borderTopWidth: 1, paddingHorizontal: 14, paddingBottom: 10 },
  activityHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 44 },
  activityTitle: { fontSize: 13, fontWeight: "600" },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 24 },
  activityText: { flex: 1, fontSize: 12 },
  activityTime: { fontSize: 11 },
});
