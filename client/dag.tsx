import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useWorkspace,
  type PluginAgentPanelProps,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  getSnapshotRpc,
  listProjectsRpc,
  listSessionsRpc,
  type DagRun,
  type DagSession,
  type DagSnapshotPayload,
  type DagTask,
} from "../shared/dag.js";
import { agentDagSnapshotRpc } from "../shared/row.js";
import { graphTypography, READABLE_MIN_SCALE } from "./graph-visual.js";

// ============================================================================
// Formatting & Pure Helpers
// ============================================================================

export function getStatusLabel(status?: string): string {
  switch (status) {
    case "running":
      return "실행 중";
    case "completed":
      return "완료";
    case "failed":
      return "실패";
    case "error":
      return "오류";
    case "blocked":
      return "의존 대기";
    case "scheduled":
      return "배정";
    case "pending":
      return "대기";
    case "paused":
      return "일시정지";
    case "cancelled":
      return "취소됨";
    case "skipped":
      return "건너뜀";
    case "interrupted":
      return "중단";
    case "lost":
      return "유실";
    default:
      return status || "미확인";
  }
}

export function getStatusGlyph(status?: string): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "failed":
    case "error":
      return "×";
    case "blocked":
      return "◌";
    case "scheduled":
      return "◷";
    case "pending":
      return "○";
    case "paused":
      return "⏸";
    case "cancelled":
    case "interrupted":
      return "−";
    case "skipped":
      return "·";
    case "lost":
      return "?";
    default:
      return "•";
  }
}

export function getStatusColor(status: string | undefined, theme: PluginTheme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "completed":
      return theme.colors.statusSuccess;
    case "failed":
    case "error":
      return theme.colors.statusDanger;
    case "blocked":
    case "scheduled":
    case "paused":
      return theme.colors.statusWarning;
    case "pending":
    case "cancelled":
    case "skipped":
    case "interrupted":
    case "lost":
    default:
      return theme.colors.foregroundMuted;
  }
}

export function formatKoreanDateTime(isoString?: string): string {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${month}/${day} ${hours}:${minutes}:${seconds}`;
}

export function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso) return "-";
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return "-";

  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(end) || end < start) return "-";

  const totalSec = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분 ${seconds}초`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }
  return `${seconds}초`;
}

// ============================================================================
/** Short label for a daemon-local path shown on a potentially remote client. */
export function localPathLabel(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const isAbsolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/");
  if (!isAbsolute) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Copy for the card shown when a project path yields no sessions.
 *
 * Extracted so the unset-path case can be pinned: the global surface opens with
 * no path chosen at all, which is a prompt rather than a search result.
 */
export function emptySessionsCopy(cwd: string): { title: string; description: string } {
  // No path chosen yet is the surface's opening state, not a failed search, so
  // it asks for a path instead of reporting that `""` contained nothing.
  if (cwd.trim() === "") {
    return {
      title: "프로젝트 경로를 입력하세요",
      description:
        "위 입력란에 OmO 작업을 실행한 프로젝트 경로를 넣고 적용하면 해당 경로의 세션과 DAG 기록이 표시됩니다.",
    };
  }

  return {
    title: "발견된 OmO 세션이 없습니다",
    description: `경로 "${localPathLabel(cwd)}"에 기록된 OmO 워크플로우 또는 태스크가 없습니다. 새 작업을 실행하면 자동으로 세션과 DAG가 표시됩니다.`,
  };
}

// Topological Layering & Graph Analytics
// ============================================================================

export type DagNode = DagRun["nodes"][number];
export type DagEdge = DagRun["edges"][number];

export interface NodeDependencyMaps {
  upstreamMap: Map<string, string[]>;
  downstreamMap: Map<string, string[]>;
}

export function buildDependencyMaps(edges: DagEdge[]): NodeDependencyMaps {
  const upstreamMap = new Map<string, string[]>();
  const downstreamMap = new Map<string, string[]>();

  for (const edge of edges) {
    const ups = upstreamMap.get(edge.to) ?? [];
    ups.push(edge.from);
    upstreamMap.set(edge.to, ups);

    const downs = downstreamMap.get(edge.from) ?? [];
    downs.push(edge.to);
    downstreamMap.set(edge.from, downs);
  }

  return { upstreamMap, downstreamMap };
}

export interface DagLayerGroup {
  layerIndex: number;
  isRoot: boolean;
  nodes: DagNode[];
}

export function computeDagLayers(nodes: DagNode[], edges: DagEdge[]): DagLayerGroup[] {
  if (nodes.length === 0) return [];

  const { upstreamMap } = buildDependencyMaps(edges);
  const levelMap = new Map<string, number>();

  function getNodeLevel(nodeId: string, visited: Set<string>): number {
    const cached = levelMap.get(nodeId);
    if (cached !== undefined) return cached;
    if (visited.has(nodeId)) return 0; // Cycle safeguard

    visited.add(nodeId);
    const upstreams = upstreamMap.get(nodeId) ?? [];
    if (upstreams.length === 0) {
      levelMap.set(nodeId, 0);
      return 0;
    }

    let maxLevel = -1;
    for (const upId of upstreams) {
      const upLvl = getNodeLevel(upId, new Set(visited));
      if (upLvl > maxLevel) {
        maxLevel = upLvl;
      }
    }

    const computed = maxLevel + 1;
    levelMap.set(nodeId, computed);
    return computed;
  }

  for (const node of nodes) {
    getNodeLevel(node.id, new Set());
  }

  const grouped = new Map<number, DagNode[]>();
  for (const node of nodes) {
    const lvl = levelMap.get(node.id) ?? 0;
    const list = grouped.get(lvl) ?? [];
    list.push(node);
    grouped.set(lvl, list);
  }

  const sortedLayers = Array.from(grouped.keys()).sort((a, b) => a - b);
  return sortedLayers.map((layerIndex) => ({
    layerIndex,
    isRoot: layerIndex === 0,
    nodes: grouped.get(layerIndex) ?? [],
  }));
}

// ============================================================================
// 2D Graph Geometry & Edge Routing (React Native View Primitives)
// ============================================================================

export interface GraphNodeLayout {
  node: DagNode;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface GraphEdgeSegment {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphEdgeLayout {
  from: string;
  to: string;
  segments: GraphEdgeSegment[];
  arrow: { x: number; y: number };
}

export interface GraphLayoutResult {
  nodes: GraphNodeLayout[];
  edges: GraphEdgeLayout[];
  canvasWidth: number;
  canvasHeight: number;
  /**
   * Factor the geometry was multiplied by to fit the viewport, 1 when nothing
   * was shrunk. The renderer needs it for type: a font that rides a shrinking
   * box down stops being readable, so it is sized from this instead.
   */
  scale: number;
}

export function computeGraphLayout(
  nodes: DagNode[],
  edges: DagEdge[],
  options: {
    nodeWidth?: number;
    nodeHeight?: number;
    colGap?: number;
    rowGap?: number;
    padding?: number;
    /**
     * Width of the box the canvas is drawn into, when the caller measured one.
     *
     * Every node carries absolute coordinates, so a canvas centred by styling
     * would still hold its nodes against its left edge: the centring has to
     * happen here.
     */
    viewportWidth?: number;
    /**
     * How far the graph may shrink to fit `viewportWidth` before it stops and
     * scrolls instead. Absent, the graph never shrinks - which is what a wide
     * panel wants, and what a phone cannot afford.
     */
    minScale?: number;
  } = {},
): GraphLayoutResult {
  const nodeWidth = options.nodeWidth ?? 190;
  const nodeHeight = options.nodeHeight ?? 60;
  const colGap = options.colGap ?? 28;
  const rowGap = options.rowGap ?? 44;
  const padding = options.padding ?? 20;

  if (nodes.length === 0) {
    return { nodes: [], edges: [], canvasWidth: 0, canvasHeight: 0, scale: 1 };
  }

  const layers = computeDagLayers(nodes, edges);
  const maxCols = Math.max(...layers.map((l) => l.nodes.length), 1);
  const maxLayerWidth = maxCols * nodeWidth + (maxCols - 1) * colGap;
  const canvasWidth = maxLayerWidth + padding * 2;
  const canvasHeight = layers.length * nodeHeight + (layers.length - 1) * rowGap + padding * 2;

  const nodePositionMap = new Map<string, GraphNodeLayout>();
  const layoutNodes: GraphNodeLayout[] = [];

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    if (!layer) continue;
    const layerNodeCount = layer.nodes.length;
    const currentLayerWidth = layerNodeCount * nodeWidth + (layerNodeCount - 1) * colGap;
    const layerOffsetX = padding + (maxLayerWidth - currentLayerWidth) / 2;
    const layerY = padding + layerIdx * (nodeHeight + rowGap);

    for (let colIdx = 0; colIdx < layerNodeCount; colIdx++) {
      const node = layer.nodes[colIdx];
      if (!node) continue;
      const x = layerOffsetX + colIdx * (nodeWidth + colGap);
      const y = layerY;

      const layoutItem: GraphNodeLayout = {
        node,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        layer: layerIdx,
      };

      nodePositionMap.set(node.id, layoutItem);
      layoutNodes.push(layoutItem);
    }
  }

  const layoutEdges: GraphEdgeLayout[] = [];
  for (const edge of edges) {
    const fromLayout = nodePositionMap.get(edge.from);
    const toLayout = nodePositionMap.get(edge.to);
    if (!fromLayout || !toLayout) continue;

    const startX = fromLayout.x + fromLayout.width / 2;
    const startY = fromLayout.y + fromLayout.height;
    const endX = toLayout.x + toLayout.width / 2;
    const endY = toLayout.y;

    const segments: GraphEdgeSegment[] = [];
    const lineWidth = 2;

    if (Math.abs(startX - endX) < 1) {
      // Direct vertical line
      segments.push({
        x: startX - lineWidth / 2,
        y: startY,
        width: lineWidth,
        height: Math.max(0, endY - startY),
      });
    } else {
      // Orthogonal Manhattan routing (Down -> Across -> Down)
      const midY = startY + (endY - startY) / 2;

      // 1. Vertical down from parent bottom
      segments.push({
        x: startX - lineWidth / 2,
        y: startY,
        width: lineWidth,
        height: Math.max(0, midY - startY),
      });

      // 2. Horizontal segment
      const minX = Math.min(startX, endX);
      const segWidth = Math.abs(endX - startX) + lineWidth;
      segments.push({
        x: minX - lineWidth / 2,
        y: midY - lineWidth / 2,
        width: segWidth,
        height: lineWidth,
      });

      // 3. Vertical down to child top
      segments.push({
        x: endX - lineWidth / 2,
        y: midY,
        width: lineWidth,
        height: Math.max(0, endY - midY),
      });
    }

    layoutEdges.push({
      from: edge.from,
      to: edge.to,
      segments,
      arrow: {
        x: endX - 4,
        y: endY - 8,
      },
    });
  }

  // A graph too wide for its box shrinks to fit when the caller allows it, and
  // only down to the floor past which its labels stop being readable; beyond
  // that it keeps its size and the canvas scrolls as it always did.
  const viewportWidth = options.viewportWidth ?? 0;
  const scale =
    options.minScale !== undefined && viewportWidth > 0 && canvasWidth > viewportWidth
      ? Math.max(options.minScale, viewportWidth / canvasWidth)
      : 1;

  const fitted =
    scale === 1
      ? { nodes: layoutNodes, edges: layoutEdges, canvasWidth, canvasHeight }
      : {
          nodes: layoutNodes.map((item) => ({
            ...item,
            x: item.x * scale,
            y: item.y * scale,
            width: item.width * scale,
            height: item.height * scale,
          })),
          edges: layoutEdges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            segments: edge.segments.map((segment) => ({
              x: segment.x * scale,
              y: segment.y * scale,
              width: segment.width * scale,
              height: segment.height * scale,
            })),
            arrow: { x: edge.arrow.x * scale, y: edge.arrow.y * scale },
          })),
          canvasWidth: canvasWidth * scale,
          canvasHeight: canvasHeight * scale,
        };

  // A graph narrower than its box is centred as one block; a wider one keeps its
  // own width so the existing horizontal scroll still reaches its right edge.
  if (viewportWidth > fitted.canvasWidth) {
    const shift = (viewportWidth - fitted.canvasWidth) / 2;
    return {
      nodes: fitted.nodes.map((item) => ({ ...item, x: item.x + shift })),
      edges: fitted.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        segments: edge.segments.map((segment) => ({ ...segment, x: segment.x + shift })),
        arrow: { x: edge.arrow.x + shift, y: edge.arrow.y },
      })),
      canvasWidth: viewportWidth,
      canvasHeight: fitted.canvasHeight,
      scale,
    };
  }

  return {
    nodes: fitted.nodes,
    edges: fitted.edges,
    canvasWidth: fitted.canvasWidth,
    canvasHeight: fitted.canvasHeight,
    scale,
  };
}

export interface TaskHierarchy {
  allTasksMap: Map<string, DagTask>;
  standaloneRootTasks: DagTask[];
  childTasksMap: Map<string, DagTask[]>;
}

export function computeTaskHierarchy(tasks: DagTask[], runs: DagRun[]): TaskHierarchy {
  const allTasksMap = new Map<string, DagTask>(tasks.map((t) => [t.id, t]));
  const linkedTaskIds = new Set<string>();

  for (const run of runs) {
    for (const node of run.nodes) {
      if (node.taskId) {
        linkedTaskIds.add(node.taskId);
      }
    }
  }

  const childTasksMap = new Map<string, DagTask[]>();
  const standaloneRootTasks: DagTask[] = [];

  for (const task of tasks) {
    if (task.parentTaskId) {
      const list = childTasksMap.get(task.parentTaskId) ?? [];
      list.push(task);
      childTasksMap.set(task.parentTaskId, list);
    } else if (!linkedTaskIds.has(task.id)) {
      standaloneRootTasks.push(task);
    }
  }

  standaloneRootTasks.sort((a, b) => {
    const aRunning = a.status === "running" ? 1 : 0;
    const bRunning = b.status === "running" ? 1 : 0;
    if (bRunning !== aRunning) return bRunning - aRunning;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });

  return { allTasksMap, standaloneRootTasks, childTasksMap };
}

export interface SessionStats {
  totalRuns: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
}

export function calculateSessionStats(snapshot: DagSnapshotPayload | null | undefined): SessionStats {
  if (!snapshot) {
    return {
      totalRuns: 0,
      runningRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      totalTasks: 0,
      runningTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
    };
  }

  let runningRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  for (const run of snapshot.runs) {
    if (run.status === "running") runningRuns++;
    else if (run.status === "completed") completedRuns++;
    else if (run.status === "failed") failedRuns++;
  }

  let runningTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;
  for (const task of snapshot.tasks) {
    if (task.status === "running") runningTasks++;
    else if (task.status === "completed") completedTasks++;
    else if (
      task.status === "failed" ||
      task.status === "error" ||
      task.status === "interrupted" ||
      task.status === "lost"
    ) {
      failedTasks++;
    }
  }

  return {
    totalRuns: snapshot.runs.length,
    runningRuns,
    completedRuns,
    failedRuns,
    totalTasks: snapshot.tasks.length,
    runningTasks,
    completedTasks,
    failedTasks,
  };
}

// ============================================================================
// Effective State & Folding Helpers
// ============================================================================

export function isNodeExpanded(
  runId: string,
  nodeId: string,
  state: string,
  foldedNodes: Record<string, boolean>,
): boolean {
  const key = `${runId}:${nodeId}`;
  const explicit = foldedNodes[key];
  if (explicit !== undefined) return explicit;
  return state === "running" || state === "failed";
}

export function toggleNodeExpanded(
  runId: string,
  nodeId: string,
  state: string,
  foldedNodes: Record<string, boolean>,
): Record<string, boolean> {
  const key = `${runId}:${nodeId}`;
  const current = isNodeExpanded(runId, nodeId, state, foldedNodes);
  return {
    ...foldedNodes,
    [key]: !current,
  };
}

export function isRunExpanded(
  runId: string,
  foldedRuns: Record<string, boolean>,
): boolean {
  const explicit = foldedRuns[runId];
  if (explicit !== undefined) return explicit;
  return true;
}

export function toggleRunExpanded(
  runId: string,
  foldedRuns: Record<string, boolean>,
): Record<string, boolean> {
  const current = isRunExpanded(runId, foldedRuns);
  return {
    ...foldedRuns,
    [runId]: !current,
  };
}

export function isTaskExpanded(
  taskId: string,
  status: string | undefined,
  foldedTasks: Record<string, boolean>,
): boolean {
  const explicit = foldedTasks[taskId];
  if (explicit !== undefined) return explicit;
  return status === "running";
}

export function toggleTaskExpanded(
  taskId: string,
  status: string | undefined,
  foldedTasks: Record<string, boolean>,
): Record<string, boolean> {
  const current = isTaskExpanded(taskId, status, foldedTasks);
  return {
    ...foldedTasks,
    [taskId]: !current,
  };
}

// ============================================================================
// Subcomponents
// ============================================================================

export interface SessionSelectorBarProps {
  cwd: string;
  sessions: DagSession[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRefresh: () => void;
  isFetching: boolean;
  theme: PluginTheme;
  compact: boolean;
}

export function SessionSelectorBar({
  cwd,
  sessions,
  selectedSessionId,
  onSelectSession,
  onRefresh,
  isFetching,
  theme,
  compact,
}: SessionSelectorBarProps): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null);
  const [showAllDropdown, setShowAllDropdown] = useState(false);

  return (
    <View
      style={[
        styles.toolbarContainer,
        compact && styles.toolbarContainerCompact,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={[styles.toolbarHeaderRow, compact && styles.toolbarHeaderRowCompact]}>
        <View style={[styles.toolbarTitleGroup, compact && styles.toolbarTitleGroupCompact]}>
          <Text style={[styles.toolbarTitle, { color: theme.colors.foreground }]}>OmO 세션</Text>
          <Text
            style={[styles.cwdText, { color: theme.colors.foregroundMuted }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {localPathLabel(cwd)}
          </Text>
        </View>

        <View style={[styles.toolbarActionsGroup, compact && styles.toolbarActionsGroupCompact]}>
          {sessions.length > 3 ? (
            <View style={[styles.scrollNavRow, compact && styles.scrollNavRowCompact]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="세션 목록 왼쪽으로 이동"
                onPress={() => scrollRef.current?.scrollTo({ x: 0, animated: true })}
                style={({ pressed }) => [
                  styles.navMiniButton,
                  {
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={[styles.navMiniButtonText, { color: theme.colors.foreground }]}>◀</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="전체 세션 목록 드롭다운 토글"
                accessibilityState={{ expanded: showAllDropdown }}
                onPress={() => setShowAllDropdown((prev) => !prev)}
                style={({ pressed }) => [
                  styles.navMiniButton,
                  {
                    backgroundColor: showAllDropdown ? theme.colors.accent : theme.colors.surface2,
                    borderColor: showAllDropdown ? theme.colors.accent : theme.colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.navMiniButtonText,
                    {
                      color: showAllDropdown
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    },
                  ]}
                >
                  목록 ({sessions.length})
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="세션 목록 오른쪽으로 이동"
                onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
                style={({ pressed }) => [
                  styles.navMiniButton,
                  {
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={[styles.navMiniButtonText, { color: theme.colors.foreground }]}>▶</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="세션 및 DAG 데이터 새로고침"
            accessibilityState={{ disabled: isFetching }}
            onPress={onRefresh}
            disabled={isFetching}
            style={({ pressed }) => [
              styles.refreshButton,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            {isFetching ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : (
              <Text style={[styles.refreshButtonText, { color: theme.colors.foreground }]}>
                ⟳ 새로고침
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Show all sessions dropdown / list view */}
      {showAllDropdown && sessions.length > 0 ? (
        <View
          style={[
            styles.allSessionsDropdown,
            {
              backgroundColor: theme.colors.surface0,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text style={[styles.dropdownHeader, { color: theme.colors.foregroundMuted }]}>
            전체 세션 선택 ({sessions.length}개)
          </Text>
          <ScrollView style={styles.dropdownScroll} nestedScrollEnabled={true}>
            {sessions.map((session, index) => {
              const isSelected = session.id === selectedSessionId;
              return (
                <Pressable
                  key={session.id}
                  accessibilityRole="button"
                  accessibilityLabel={`세션 선택: ${session.id}`}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => {
                    onSelectSession(session.id);
                    setShowAllDropdown(false);
                  }}
                  style={({ pressed }) => [
                    styles.dropdownItem,
                    {
                      backgroundColor: isSelected
                        ? theme.colors.surface2
                        : pressed
                        ? theme.colors.surface1
                        : theme.colors.surface0,
                      borderLeftColor: isSelected
                        ? theme.colors.accent
                        : "transparent",
                    },
                  ]}
                >
                  <View style={[styles.dropdownItemHeader, compact && styles.dropdownItemHeaderCompact]}>
                    <Text
                      style={[
                        styles.dropdownItemId,
                        {
                          color: isSelected
                            ? theme.colors.accent
                            : theme.colors.foreground,
                          fontWeight: isSelected ? "700" : "500",
                        },
                      ]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {index === 0 ? "★ [최신] " : ""}{session.id}
                    </Text>
                    <Text
                      style={[styles.dropdownItemMeta, { color: theme.colors.foregroundMuted }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      DAG {session.runCount} · 태스크 {session.taskCount}
                    </Text>
                  </View>
                  <Text
                    style={[styles.dropdownItemDate, { color: theme.colors.foregroundMuted }]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {formatKoreanDateTime(session.createdAt)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {sessions.length > 0 ? (
        <ScrollView
          ref={scrollRef}
          horizontal={!compact}
          showsHorizontalScrollIndicator={!compact}
          contentContainerStyle={[
            styles.sessionPillsScroll,
            compact && styles.sessionPillsScrollCompact,
          ]}
        >
          {sessions.map((session, index) => {
            const isSelected = session.id === selectedSessionId;
            const isLatest = index === 0;
            return (
              <Pressable
                key={session.id}
                accessibilityRole="button"
                accessibilityLabel={`세션 선택: ${session.id}`}
                accessibilityState={{ selected: isSelected }}
                onPress={() => onSelectSession(session.id)}
                style={({ pressed }) => [
                  styles.sessionPill,
                  compact && styles.sessionPillCompact,
                  {
                    backgroundColor: isSelected ? theme.colors.accent : theme.colors.surface2,
                    borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <View style={styles.sessionPillHeader}>
                  {isLatest ? (
                    <View
                      style={[
                        styles.latestTag,
                        {
                          backgroundColor: isSelected
                            ? theme.colors.surface0
                            : theme.colors.accent,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.latestTagText,
                          {
                            color: isSelected ? theme.colors.accent : theme.colors.accentForeground,
                          },
                        ]}
                      >
                        최신
                      </Text>
                    </View>
                  ) : null}
                  <Text
                    style={[
                      styles.sessionPillId,
                      {
                        color: isSelected
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                      },
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {session.id.slice(0, 12)}…
                  </Text>
                </View>
                <Text
                  style={[
                    styles.sessionPillMeta,
                    {
                      color: isSelected
                        ? theme.colors.accentForeground
                        : theme.colors.foregroundMuted,
                    },
                  ]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {formatKoreanDateTime(session.createdAt)} · DAG {session.runCount} · 태스크 {session.taskCount}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

export interface SessionStatsBarProps {
  stats: SessionStats;
  theme: PluginTheme;
  compact: boolean;
}

export function SessionStatsBar({ stats, theme, compact }: SessionStatsBarProps): React.JSX.Element {
  const items = [
    { label: "DAG 실행", value: stats.totalRuns, color: theme.colors.foreground },
    {
      label: "실행 중",
      value: stats.runningRuns + stats.runningTasks,
      color: theme.colors.accent,
    },
    {
      label: "완료",
      value: stats.completedRuns + stats.completedTasks,
      color: theme.colors.statusSuccess,
    },
    ...(stats.failedRuns > 0 || stats.failedTasks > 0
      ? [
          {
            label: "실패/오류",
            value: stats.failedRuns + stats.failedTasks,
            color: theme.colors.statusDanger,
          },
        ]
      : []),
    { label: "일반 작업", value: stats.totalTasks, color: theme.colors.foreground },
  ];

  return (
    <View
      style={[
        styles.statsBar,
        compact && styles.statsBarCompact,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.label}>
          {index > 0 ? (
            <View
              style={[
                styles.statDivider,
                compact && styles.statDividerCompact,
                { backgroundColor: theme.colors.border },
              ]}
            />
          ) : null}
          <View style={[styles.statItem, compact && styles.statItemCompact]}>
            <Text
              style={[
                styles.statLabel,
                {
                  color:
                    item.label === "DAG 실행" || item.label === "일반 작업"
                      ? theme.colors.foregroundMuted
                      : item.color,
                },
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item.label}
            </Text>
            <Text style={[styles.statValue, { color: item.color }]}>{item.value}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

// ============================================================================
// 2D DAG Graph Run Card
// ============================================================================

export interface DagRunCardProps {
  run: DagRun;
  tasksMap: Map<string, DagTask>;
  childTasksMap: Map<string, DagTask[]>;
  foldedRuns: Record<string, boolean>;
  onToggleRunFold: (runId: string) => void;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  foldedTasks: Record<string, boolean>;
  onToggleTaskFold: (taskId: string, status?: string) => void;
  theme: PluginTheme;
  compact: boolean;
}

export function DagRunCard({
  run,
  tasksMap,
  childTasksMap,
  foldedRuns,
  onToggleRunFold,
  selectedNodeId,
  onSelectNode,
  foldedTasks,
  onToggleTaskFold,
  theme,
  compact,
}: DagRunCardProps): React.JSX.Element {
  const isFolded = !isRunExpanded(run.id, foldedRuns);
  const statusColor = getStatusColor(run.status, theme);
  const statusLabel = getStatusLabel(run.status);

  // Measured from the card itself: the graph is centred in the width it really
  // gets, which is the whole point on a wide panel where it used to hug the
  // left edge.
  const [graphBoxWidth, setGraphBoxWidth] = useState(0);
  const graphLayout = useMemo(
    () =>
      computeGraphLayout(run.nodes, run.edges, {
        nodeWidth: compact ? 124 : 190,
        // Tall enough that even at the scale floor the node stays a legal touch
        // target (76 * 0.58 = 44) and still holds both of its lines.
        nodeHeight: compact ? 76 : 60,
        colGap: compact ? 12 : 28,
        rowGap: compact ? 22 : 44,
        padding: compact ? 8 : 20,
        // Only a phone trades size for fit: the wide panel has the room to draw
        // the graph outright and scroll when a run is genuinely enormous.
        ...(compact ? { minScale: READABLE_MIN_SCALE } : {}),
        ...(graphBoxWidth > 0 ? { viewportWidth: graphBoxWidth } : {}),
      }),
    [run.nodes, run.edges, compact, graphBoxWidth],
  );

  const handleGraphBoxLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) => {
      const width = Math.round(event.nativeEvent.layout.width);
      if (width > 0 && width !== graphBoxWidth) setGraphBoxWidth(width);
    },
    [graphBoxWidth],
  );

  // Type and chrome answer to the fit rather than to the box: type that rode a
  // shrinking node down would leave a graph that fits and cannot be read, so it
  // is sized from the scale and stops at a readable floor.
  const nodeType = graphTypography(graphLayout.scale, compact);
  const nodeGlyphSize = Math.max(12, Math.round(18 * graphLayout.scale));
  const nodePadding = Math.max(3, Math.round(8 * graphLayout.scale));

  const completedCount = run.nodes.filter((n) => n.state === "completed").length;
  const runningCount = run.nodes.filter((n) => n.state === "running").length;
  const failedCount = run.nodes.filter((n) => n.state === "failed").length;
  const totalNodes = run.nodes.length;

  const selectedNode = selectedNodeId
    ? run.nodes.find((n) => n.id === selectedNodeId)
    : undefined;
  const selectedTask = selectedNode?.taskId ? tasksMap.get(selectedNode.taskId) : undefined;
  const selectedTaskChildren = selectedNode?.taskId
    ? childTasksMap.get(selectedNode.taskId) ?? []
    : [];

  return (
    <View
      style={[
        styles.runCard,
        compact && styles.runCardCompact,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: run.status === "running" ? theme.colors.accent : theme.colors.border,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`DAG 실행 접기/펼치기: ${run.name || run.id}`}
        accessibilityState={{ expanded: !isFolded }}
        onPress={() => onToggleRunFold(run.id)}
        style={[styles.runCardHeader, compact && styles.runCardHeaderCompact]}
      >
        <View style={[styles.runTitleGroup, compact && styles.runTitleGroupCompact]}>
          <View style={[styles.runTitleRow, compact && styles.runTitleRowCompact]}>
            <Text
              style={[styles.runNameText, { color: theme.colors.foreground }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {run.name || run.id}
            </Text>
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: theme.colors.surface2,
                  borderColor: statusColor,
                },
              ]}
            >
              <Text style={[styles.statusBadgeText, { color: statusColor }]}>{statusLabel}</Text>
            </View>
          </View>
          <Text
            style={[styles.runMetaText, { color: theme.colors.foregroundMuted }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            ID: {run.id} · 생성 {formatKoreanDateTime(run.createdAt)} · 노드 {completedCount}/{totalNodes} 완료
            {failedCount > 0 ? ` · 실패 ${failedCount}` : ""}
          </Text>
        </View>

        <Text style={[styles.expandToggleGlyph, { color: theme.colors.foregroundMuted }]}>
          {isFolded ? "▼ 펼치기" : "▲ 접기"}
        </Text>
      </Pressable>

      {/* Progress Bar */}
      <View
        style={[
          styles.progressBarContainer,
          {
            backgroundColor: theme.colors.surface2,
          },
        ]}
      >
        {completedCount > 0 ? (
          <View
            style={[
              styles.progressBarSegment,
              {
                backgroundColor: theme.colors.statusSuccess,
                flex: completedCount,
              },
            ]}
          />
        ) : null}
        {runningCount > 0 ? (
          <View
            style={[
              styles.progressBarSegment,
              {
                backgroundColor: theme.colors.accent,
                flex: runningCount,
              },
            ]}
          />
        ) : null}
        {failedCount > 0 ? (
          <View
            style={[
              styles.progressBarSegment,
              {
                backgroundColor: theme.colors.statusDanger,
                flex: failedCount,
              },
            ]}
          />
        ) : null}
        {totalNodes - completedCount - runningCount - failedCount > 0 ? (
          <View
            style={[
              styles.progressBarSegment,
              {
                // The remaining-work segment is a fill, not a divider: the
                // border token reads as a gap and makes the bar look broken.
                backgroundColor: theme.colors.surface2,
                flex: totalNodes - completedCount - runningCount - failedCount,
              },
            ]}
          />
        ) : null}
      </View>

      {!isFolded ? (
        <View
          style={[styles.graphContainer, compact && styles.graphContainerCompact]}
          onLayout={handleGraphBoxLayout}
        >
          {/* One canvas at every width: a phone gets the same graph, fitted to it. */}
            <ScrollView
              horizontal
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={styles.graphScrollContent}
            style={styles.graphScroll}
          >
            <View
              style={[
                styles.graphCanvas,
                {
                  width: Math.max(graphLayout.canvasWidth, compact ? 280 : 340),
                  height: Math.max(graphLayout.canvasHeight, 100),
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              {/* Orthogonal Edges */}
              {graphLayout.edges.map((edge) => (
                <React.Fragment key={`edge-${edge.from}-${edge.to}`}>
                  {edge.segments.map((seg, sIdx) => (
                    <View
                      key={`seg-${edge.from}-${edge.to}-${sIdx}`}
                      style={[
                        styles.edgeSegment,
                        {
                          left: seg.x,
                          top: seg.y,
                          width: seg.width,
                          height: seg.height,
                          backgroundColor: theme.colors.border,
                        },
                      ]}
                    />
                  ))}
                  {/* Arrowhead */}
                  <Text
                    style={[
                      styles.edgeArrowhead,
                      {
                        left: edge.arrow.x,
                        top: edge.arrow.y,
                        color: theme.colors.foregroundMuted,
                      },
                    ]}
                  >
                    ▼
                  </Text>
                </React.Fragment>
              ))}

              {/* Positioned Node Cards */}
              {graphLayout.nodes.map((item) => {
                const isSelected = selectedNodeId === item.node.id;
                const nodeStatusColor = getStatusColor(item.node.state, theme);
                const nodeStatusGlyph = getStatusGlyph(item.node.state);
                const nodeStatusLabel = getStatusLabel(item.node.state);

                return (
                  <Pressable
                    key={item.node.id}
                    accessibilityRole="button"
                    accessibilityLabel={`노드 선택: ${item.node.label}`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => onSelectNode(isSelected ? null : item.node.id)}
                    style={({ pressed }) => [
                      styles.graphNodeCard,
                      {
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height,
                        padding: nodePadding,
                        // The canvas card is already surface1, so an unselected
                        // node filled with surface1 had no body at all — only a
                        // 1px border floating on the background.
                        backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface0,
                        borderColor: isSelected
                          ? theme.colors.accent
                          : item.node.state === "running"
                          ? theme.colors.accent
                          : theme.colors.border,
                        borderWidth: isSelected ? 2 : 1,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <View style={styles.graphNodeHeader}>
                      <View
                        style={[
                          styles.statusGlyphBadge,
                          {
                            backgroundColor: theme.colors.surface0,
                            borderColor: nodeStatusColor,
                            width: nodeGlyphSize,
                            height: nodeGlyphSize,
                            borderRadius: nodeGlyphSize / 2,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusGlyphText,
                            { color: nodeStatusColor, fontSize: nodeType.glyph },
                          ]}
                        >
                          {nodeStatusGlyph}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.graphNodeLabel,
                          { color: theme.colors.foreground, fontSize: nodeType.label },
                        ]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {item.node.label}
                      </Text>
                    </View>

                    <View style={styles.graphNodeFooter}>
                      <Text
                        style={[
                          styles.graphNodeId,
                          { color: theme.colors.foregroundMuted, fontSize: nodeType.state },
                        ]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {item.node.id}
                      </Text>
                      <View
                        style={[
                          styles.statusBadge,
                          {
                            backgroundColor: theme.colors.surface0,
                            borderColor: nodeStatusColor,
                            paddingHorizontal: 4,
                            paddingVertical: 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusBadgeText,
                            { color: nodeStatusColor, fontSize: nodeType.state },
                          ]}
                        >
                          {nodeStatusLabel}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            </ScrollView>

          {/* Selected Node Details Inspector */}
          {selectedNode ? (
            <View
              style={[
                styles.nodeInspectorContainer,
                {
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <View style={[styles.nodeInspectorHeader, compact && styles.nodeInspectorHeaderCompact]}>
                <View style={styles.nodeTitleGroup}>
                  <Text
                    style={[styles.nodeInspectorTitle, { color: theme.colors.foreground }]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    노드 상세: {selectedNode.label}
                  </Text>
                  <Text
                    style={[styles.nodeIdSub, { color: theme.colors.foregroundMuted }]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {selectedNode.id} {selectedNode.attempt > 0 ? `· 시도 ${selectedNode.attempt + 1}` : ""}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="상세 닫기"
                  onPress={() => onSelectNode(null)}
                  style={styles.inspectorCloseButton}
                >
                  <Text style={[styles.inspectorCloseText, { color: theme.colors.foregroundMuted }]}>
                    ✕ 닫기
                  </Text>
                </Pressable>
              </View>

              {/* Error Message */}
              {selectedNode.error ? (
                <View
                  style={[
                    styles.nodeErrorBox,
                    {
                      backgroundColor: theme.colors.surface1,
                      borderColor: theme.colors.statusDanger,
                    },
                  ]}
                >
                  <Text style={[styles.nodeErrorTitle, { color: theme.colors.statusDanger }]}>
                    오류 발생
                  </Text>
                  <Text style={[styles.nodeErrorText, { color: theme.colors.foreground }]}>
                    {selectedNode.error}
                  </Text>
                </View>
              ) : null}

              {/* Task Details */}
              {selectedTask?.description ? (
                <View style={styles.detailItem}>
                  <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                    설명
                  </Text>
                  <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                    {selectedTask.description}
                  </Text>
                </View>
              ) : null}

              <View style={[styles.detailGrid, compact && styles.detailGridCompact]}>
                {selectedTask?.agent ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      에이전트
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {selectedTask.agent}
                    </Text>
                  </View>
                ) : null}

                {selectedTask?.model ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      모델
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {selectedTask.model}
                    </Text>
                  </View>
                ) : null}

                {selectedTask?.turns !== undefined ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      턴
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {selectedTask.turns}턴
                    </Text>
                  </View>
                ) : null}

                {selectedTask?.toolCalls !== undefined ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      도구 호출
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {selectedTask.toolCalls}회
                    </Text>
                  </View>
                ) : null}

                {selectedTask?.startedAt ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      경과 시간
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {formatDuration(selectedTask.startedAt, selectedTask.completedAt)}
                    </Text>
                  </View>
                ) : null}

                {selectedTask?.startedAt ? (
                  <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                    <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                      시작 시각
                    </Text>
                    <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                      {formatKoreanDateTime(selectedTask.startedAt)}
                    </Text>
                  </View>
                ) : null}
              </View>

              {selectedTask?.progress ? (
                <View
                  style={[
                    styles.liveProgressBox,
                    {
                      backgroundColor: theme.colors.surface1,
                      borderColor: theme.colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.liveProgressLabel, { color: theme.colors.accent }]}>
                    진행 상황
                  </Text>
                  <Text style={[styles.liveProgressText, { color: theme.colors.foreground }]}>
                    {selectedTask.progress}
                  </Text>
                </View>
              ) : null}

              {selectedNode.taskId ? (
                <Text style={[styles.taskIdFooter, { color: theme.colors.foregroundMuted }]}>
                  연결된 태스크 ID: {selectedNode.taskId}
                </Text>
              ) : null}

              {/* Linked Task Subtasks */}
              {selectedTaskChildren.length > 0 ? (
                <View style={styles.childTasksContainer}>
                  <Text style={[styles.childTasksHeader, { color: theme.colors.foregroundMuted }]}>
                    하위 작업 ({selectedTaskChildren.length}개)
                  </Text>
                  {selectedTaskChildren.map((child) => (
                    <TaskItemCard
                      key={child.id}
                      task={child}
                      childTasksMap={childTasksMap}
                      foldedTasks={foldedTasks}
                      onToggleTaskFold={onToggleTaskFold}
                      theme={theme}
                      compact={compact}
                      depth={1}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={[styles.graphInstructionText, { color: theme.colors.foregroundMuted }]}>
              💡 노드를 클릭하면 하단에 상세 정보 및 연계 작업 내역이 표시됩니다.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

// ============================================================================
// Standalone & Subtask Item Card
// ============================================================================

export interface TaskItemCardProps {
  task: DagTask;
  childTasksMap: Map<string, DagTask[]>;
  foldedTasks: Record<string, boolean>;
  onToggleTaskFold: (taskId: string, status?: string) => void;
  theme: PluginTheme;
  compact: boolean;
  depth?: number;
}

export function TaskItemCard({
  task,
  childTasksMap,
  foldedTasks,
  onToggleTaskFold,
  theme,
  compact,
  depth = 0,
}: TaskItemCardProps): React.JSX.Element {
  const isExpanded = isTaskExpanded(task.id, task.status, foldedTasks);
  const children = childTasksMap.get(task.id) ?? [];
  const statusColor = getStatusColor(task.status, theme);
  const statusGlyph = getStatusGlyph(task.status);
  const statusLabel = getStatusLabel(task.status);
  const duration = formatDuration(task.startedAt, task.completedAt);

  return (
    <View
      style={[
        styles.taskCard,
        compact && styles.taskCardCompact,
        {
          backgroundColor: theme.colors.surface0,
          borderColor: task.status === "running" ? theme.colors.accent : theme.colors.border,
          marginLeft: depth * (compact ? 8 : 16),
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`작업 상세 토글: ${task.description || task.id}`}
        accessibilityState={{ expanded: isExpanded }}
        onPress={() => onToggleTaskFold(task.id, task.status)}
        style={[styles.taskCardHeader, compact && styles.taskCardHeaderCompact]}
      >
        <View style={[styles.taskHeaderLeft, compact && styles.taskHeaderLeftCompact]}>
          <View
            style={[
              styles.statusGlyphBadge,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: statusColor,
              },
            ]}
          >
            <Text style={[styles.statusGlyphText, { color: statusColor }]}>{statusGlyph}</Text>
          </View>
          <View style={styles.taskTitleGroup}>
            <Text
              style={[styles.taskDescriptionText, { color: theme.colors.foreground }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {task.description || task.id}
            </Text>
            <Text
              style={[styles.taskIdSub, { color: theme.colors.foregroundMuted }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {task.id} {task.agent ? `· ${task.agent}` : ""} {task.model ? `· ${task.model}` : ""}
            </Text>
          </View>
        </View>

        <View style={[styles.taskHeaderRight, compact && styles.taskHeaderRightCompact]}>
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: statusColor,
              },
            ]}
          >
            <Text style={[styles.statusBadgeText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          <Text style={[styles.expandToggleGlyph, { color: theme.colors.foregroundMuted }]}>
            {isExpanded ? "▲" : "▼"}
          </Text>
        </View>
      </Pressable>

      {isExpanded ? (
        <View
          style={[
            styles.taskDetailsContainer,
            {
              borderTopColor: theme.colors.border,
            },
          ]}
        >
          <View style={[styles.detailGrid, compact && styles.detailGridCompact]}>
            {task.turns !== undefined ? (
              <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>턴</Text>
                <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                  {task.turns}턴
                </Text>
              </View>
            ) : null}

            {task.toolCalls !== undefined ? (
              <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                  도구 호출
                </Text>
                <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                  {task.toolCalls}회
                </Text>
              </View>
            ) : null}

            {duration !== "-" ? (
              <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                  경과 시간
                </Text>
                <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                  {duration}
                </Text>
              </View>
            ) : null}

            {task.startedAt ? (
              <View style={[styles.detailGridItem, compact && styles.detailGridItemCompact]}>
                <Text style={[styles.detailLabel, { color: theme.colors.foregroundMuted }]}>
                  시작 시각
                </Text>
                <Text style={[styles.detailValue, { color: theme.colors.foreground }]}>
                  {formatKoreanDateTime(task.startedAt)}
                </Text>
              </View>
            ) : null}
          </View>

          {task.progress ? (
            <View
              style={[
                styles.liveProgressBox,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Text style={[styles.liveProgressLabel, { color: theme.colors.accent }]}>
                진행 상황
              </Text>
              <Text style={[styles.liveProgressText, { color: theme.colors.foreground }]}>
                {task.progress}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Child Subtasks with full recursion and isolated state */}
      {children.length > 0 ? (
        <View style={styles.childTasksContainer}>
          <Text style={[styles.childTasksHeader, { color: theme.colors.foregroundMuted }]}>
            하위 작업 ({children.length}개)
          </Text>
          {children.map((child) => (
            <TaskItemCard
              key={child.id}
              task={child}
              childTasksMap={childTasksMap}
              foldedTasks={foldedTasks}
              onToggleTaskFold={onToggleTaskFold}
              theme={theme}
              compact={compact}
              depth={depth + 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ============================================================================
// Main DAG Container View
// ============================================================================

export interface DagMainViewProps {
  cwd: string;
  theme: PluginTheme;
  compact: boolean;
  /** Agent panels resolve cwd and OmO session identity through this RPC key. */
  agentId?: string;
}

export function DagMainView({ cwd, theme, compact, agentId }: DagMainViewProps): React.JSX.Element {
  const fetchSessions = useRpc(listSessionsRpc);
  const fetchSnapshot = useRpc(getSnapshotRpc);
  const fetchAgentSnapshot = useRpc(agentDagSnapshotRpc);
  const queryClient = useQueryClient();

  const isAgentScoped = agentId !== undefined;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const activeSessionId = selectedSessionId;
  const [foldedRuns, setFoldedRuns] = useState<Record<string, boolean>>({});
  const [selectedNodeByRun, setSelectedNodeByRun] = useState<Record<string, string | null>>({});
  const [foldedTasks, setFoldedTasks] = useState<Record<string, boolean>>({});
  const [tasksSectionFolded, setTasksSectionFolded] = useState<boolean>(false);

  // Reset selected session if directory changes
  const prevCwdRef = useRef(cwd);
  useEffect(() => {
    if (prevCwdRef.current !== cwd) {
      prevCwdRef.current = cwd;
      setSelectedSessionId(null);
      setFoldedRuns({});
      setSelectedNodeByRun({});
      setFoldedTasks({});
    }
  }, [cwd]);

  // Query: Sessions list
  const sessionsQuery = useQuery({
    queryKey: ["dag", "sessions", cwd],
    queryFn: async () => {
      if (!cwd || isAgentScoped) return { sessions: [] };
      return fetchSessions({ cwd });
    },
    enabled: Boolean(cwd) && !isAgentScoped,
    refetchInterval: 3000,
  });

  const sessions = useMemo(() => sessionsQuery.data?.sessions ?? [], [sessionsQuery.data]);

  // Default to the first session on first load or when sessions change
  useEffect(() => {
    if (isAgentScoped || sessions.length === 0) return;
    const firstSession = sessions[0];
    if (firstSession && (!selectedSessionId || !sessions.some((s) => s.id === selectedSessionId))) {
      setSelectedSessionId(firstSession.id);
    }
  }, [isAgentScoped, sessions, selectedSessionId]);

  const snapshotQuery = useQuery({
    queryKey: ["dag", "snapshot", cwd, activeSessionId],
    queryFn: async () => {
      if (!cwd || !activeSessionId || isAgentScoped) return null;
      return fetchSnapshot({ cwd, sessionId: activeSessionId });
    },
    enabled: Boolean(cwd && activeSessionId) && !isAgentScoped,
    refetchInterval: 2000,
  });

  const agentSnapshotQuery = useQuery({
    queryKey: ["dag", "agent-snapshot", agentId],
    queryFn: async () => {
      if (!agentId) return null;
      return fetchAgentSnapshot({ agentId });
    },
    enabled: isAgentScoped,
    refetchInterval: 2000,
  });

  const snapshot: DagSnapshotPayload | null | undefined =
    agentId !== undefined
      ? agentSnapshotQuery.data
        ? {
            sessionId: agentSnapshotQuery.data.sessionId ?? agentId,
            runs: agentSnapshotQuery.data.runs,
            tasks: agentSnapshotQuery.data.tasks,
          }
        : agentSnapshotQuery.data
      : snapshotQuery.data;
  const stats = useMemo(() => calculateSessionStats(snapshot), [snapshot]);

  const { allTasksMap, standaloneRootTasks, childTasksMap } = useMemo(() => {
    if (!snapshot) {
      return {
        allTasksMap: new Map<string, DagTask>(),
        standaloneRootTasks: [],
        childTasksMap: new Map<string, DagTask[]>(),
      };
    }
    return computeTaskHierarchy(snapshot.tasks, snapshot.runs);
  }, [snapshot]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["dag"] });
  }, [queryClient]);

  const handleToggleRunFold = useCallback((runId: string) => {
    setFoldedRuns((prev) => toggleRunExpanded(runId, prev));
  }, []);

  const handleSelectNode = useCallback((runId: string, nodeId: string | null) => {
    setSelectedNodeByRun((prev) => ({
      ...prev,
      [runId]: nodeId,
    }));
  }, []);

  const handleToggleTaskFold = useCallback((taskId: string, status?: string) => {
    setFoldedTasks((prev) => toggleTaskExpanded(taskId, status, prev));
  }, []);

  const isLoadingSessions = !isAgentScoped && sessionsQuery.isLoading && !sessionsQuery.data;
  const isLoadingSnapshot = isAgentScoped
    ? agentSnapshotQuery.isLoading && !agentSnapshotQuery.data
    : snapshotQuery.isLoading && !snapshotQuery.data;
  const isSnapshotError = isAgentScoped ? agentSnapshotQuery.isError : snapshotQuery.isError;
  const snapshotError = isAgentScoped ? agentSnapshotQuery.error : snapshotQuery.error;
  const hasSelectedSession = isAgentScoped || activeSessionId !== null;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.surface0 }]}
      contentContainerStyle={[styles.contentContainer, compact && styles.contentContainerCompact]}
    >
      {/* Session selection belongs to the global surface, not an agent-scoped panel. */}
      {!isAgentScoped ? (
        <SessionSelectorBar
          cwd={cwd}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          onRefresh={handleRefresh}
          isFetching={sessionsQuery.isFetching || snapshotQuery.isFetching}
          theme={theme}
          compact={compact}
        />
      ) : null}

      {/* Loading State for Sessions */}
      {isLoadingSessions ? (
        <View
          style={[
            styles.stateCard,
            compact && styles.stateCardCompact,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={[styles.stateTitle, { color: theme.colors.foreground }]}>
            세션 목록을 조회하는 중입니다...
          </Text>
          <Text style={[styles.stateDesc, { color: theme.colors.foregroundMuted }]}>
            지정된 디렉토리의 OmO 태스크 및 DAG 기록을 탐색하고 있습니다.
          </Text>
        </View>
      ) : null}

      {/* Empty Sessions State (Mutually exclusive with isError) */}
      {!isAgentScoped && !isLoadingSessions && !sessionsQuery.isError && sessions.length === 0 ? (
        <View
          style={[
            styles.stateCard,
            compact && styles.stateCardCompact,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text style={[styles.stateTitle, { color: theme.colors.foreground }]}>
            {emptySessionsCopy(cwd).title}
          </Text>
          <Text style={[styles.stateDesc, { color: theme.colors.foregroundMuted }]}>
            {emptySessionsCopy(cwd).description}
          </Text>
        </View>
      ) : null}

      {/* Sessions Error State */}
      {!isAgentScoped && sessionsQuery.isError ? (
        <View
          style={[
            styles.stateCard,
            compact && styles.stateCardCompact,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.statusDanger,
            },
          ]}
        >
          <Text style={[styles.stateTitle, { color: theme.colors.statusDanger }]}>
            세션 목록을 불러올 수 없습니다
          </Text>
          <Text style={[styles.stateDesc, { color: theme.colors.foreground }]}>
            {String(sessionsQuery.error?.message || "알 수 없는 오류가 발생했습니다.")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="세션 목록 다시 불러오기"
            onPress={handleRefresh}
            style={[styles.retryButton, { backgroundColor: theme.colors.accent }]}
          >
            <Text style={[styles.retryButtonText, { color: theme.colors.accentForeground }]}>
              다시 시도
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Snapshot Content (When Session Selected) */}
      {hasSelectedSession && (
        <>
          {/* Summary Stats */}
          <SessionStatsBar stats={stats} theme={theme} compact={compact} />

          {/* Snapshot Loading State */}
          {isLoadingSnapshot ? (
            <View
              style={[
                styles.stateCard,
                compact && styles.stateCardCompact,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <ActivityIndicator size="large" color={theme.colors.accent} />
              <Text style={[styles.stateTitle, { color: theme.colors.foreground }]}>
                DAG 스냅샷 로딩 중...
              </Text>
            </View>
          ) : null}

          {/* Snapshot Error State */}
          {isSnapshotError ? (
            <View
              style={[
                styles.stateCard,
                compact && styles.stateCardCompact,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.statusDanger,
                },
              ]}
            >
              <Text style={[styles.stateTitle, { color: theme.colors.statusDanger }]}>
                스냅샷 조회 오류
              </Text>
              <Text style={[styles.stateDesc, { color: theme.colors.foreground }]}>
                {String(snapshotError?.message || "스냅샷을 읽을 수 없습니다.")}
              </Text>
            </View>
          ) : null}

          {/* Empty DAG & Tasks State */}
          {!isLoadingSnapshot && !isSnapshotError && snapshot && snapshot.runs.length === 0 && snapshot.tasks.length === 0 ? (
            <View
              style={[
                styles.stateCard,
                compact && styles.stateCardCompact,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Text style={[styles.stateTitle, { color: theme.colors.foreground }]}>
                DAG 실행 및 작업 기록 없음
              </Text>
              <Text style={[styles.stateDesc, { color: theme.colors.foregroundMuted }]}>
                {isAgentScoped
                  ? "현재 에이전트 세션에 등록된 DAG 워크플로우나 작업이 없습니다."
                  : `선택된 세션 (${activeSessionId?.slice(0, 12)}…) 에 등록된 DAG 워크플로우나 작업이 없습니다.`}
              </Text>
            </View>
          ) : null}

          {/* DAG Runs List (True 2D Graph) */}
          {snapshot && snapshot.runs.length > 0 ? (
            <View style={styles.sectionContainer}>
              <View style={[styles.sectionHeaderRow, compact && styles.sectionHeaderRowCompact]}>
                <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]}>
                  워크플로우 DAG 그래프 ({snapshot.runs.length})
                </Text>
              </View>

              {snapshot.runs.map((run) => (
                <DagRunCard
                  key={run.id}
                  run={run}
                  tasksMap={allTasksMap}
                  childTasksMap={childTasksMap}
                  foldedRuns={foldedRuns}
                  onToggleRunFold={handleToggleRunFold}
                  selectedNodeId={selectedNodeByRun[run.id] ?? null}
                  onSelectNode={(nodeId) => handleSelectNode(run.id, nodeId)}
                  foldedTasks={foldedTasks}
                  onToggleTaskFold={handleToggleTaskFold}
                  theme={theme}
                  compact={compact}
                />
              ))}
            </View>
          ) : null}

          {/* Standalone / Subtasks Section */}
          {snapshot && standaloneRootTasks.length > 0 ? (
            <View style={styles.sectionContainer}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="일반 작업 및 서브태스크 목록 접기/펼치기"
                accessibilityState={{ expanded: !tasksSectionFolded }}
                onPress={() => setTasksSectionFolded((prev) => !prev)}
                style={[styles.sectionHeaderRow, compact && styles.sectionHeaderRowCompact]}
              >
                <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]}>
                  일반 작업 / 서브태스크 ({standaloneRootTasks.length})
                </Text>
                <Text style={[styles.expandToggleGlyph, { color: theme.colors.foregroundMuted }]}>
                  {tasksSectionFolded ? "▼ 펼치기" : "▲ 접기"}
                </Text>
              </Pressable>

              {!tasksSectionFolded ? (
                <View style={styles.tasksList}>
                  {standaloneRootTasks.map((task) => (
                    <TaskItemCard
                      key={task.id}
                      task={task}
                      childTasksMap={childTasksMap}
                      foldedTasks={foldedTasks}
                      onToggleTaskFold={handleToggleTaskFold}
                      theme={theme}
                      compact={compact}
                      depth={0}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

// ============================================================================
// Exported Surface & Panel Components
// ============================================================================

function WorkspaceDagPanel({
  workspaceId,
  theme,
  layout,
}: PluginWorkspacePanelProps): React.JSX.Element {
  const directory = useWorkspace(workspaceId, (workspace) =>
    workspace.directory || workspace.projectRootPath
  ) ?? "";
  return <DagMainView cwd={directory} theme={theme} compact={layout.compact} />;
}

export function DagPanel(
  props: PluginWorkspacePanelProps | PluginAgentPanelProps,
): React.JSX.Element {
  return props.context === "agent" ? (
    <DagMainView cwd="" agentId={props.agentId} theme={props.theme} compact={props.layout.compact} />
  ) : (
    <WorkspaceDagPanel {...props} />
  );
}

/** Chips beyond this hide behind a toggle: the row is a header, not a list. */
const PROJECT_CHIP_LIMIT = 6;

export function DagGlobalSurface({
  theme,
  layout,
}: PluginSurfaceProps): React.JSX.Element {
  // A sidebar surface is not opened from a workspace, so the host cannot tell it
  // which project to show. The daemon can: it already reads every OmO session
  // header, so the surface opens on the most recently used project instead of
  // demanding an absolute path be typed - which on a phone is the difference
  // between usable and not.
  const listProjects = useRpc(listProjectsRpc);
  const projectsQuery = useQuery({
    queryKey: ["dag", "projects"],
    queryFn: () => listProjects({}),
    staleTime: 10_000,
  });
  const projects = projectsQuery.data?.projects ?? [];
  const defaultPath = projects[0]?.cwd ?? "";

  const [typedPath, setTypedPath] = useState<string | null>(null);
  const [appliedPath, setAppliedPath] = useState<string | null>(null);

  const inputPath = typedPath ?? defaultPath;
  const activePath = appliedPath ?? defaultPath;

  const handleApplyPath = useCallback(() => {
    const trimmed = inputPath.trim();
    if (trimmed) {
      setAppliedPath(trimmed);
    }
  }, [inputPath]);

  const handlePickProject = useCallback((cwd: string) => {
    setTypedPath(cwd);
    setAppliedPath(cwd);
  }, []);

  // Twenty chips filled a phone screen on their own and pushed the sessions
  // below the fold, so the row stays a header until it is asked to grow.
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const visibleProjects = projectsExpanded
    ? projects
    : (() => {
        const head = projects.slice(0, PROJECT_CHIP_LIMIT);
        // Whatever is being shown has to stay one tap away, even when it sorted
        // below the cut.
        if (head.some((project) => project.cwd === activePath)) return head;
        const active = projects.find((project) => project.cwd === activePath);
        return active === undefined ? head : [active, ...head.slice(0, PROJECT_CHIP_LIMIT - 1)];
      })();
  const hiddenProjectCount = projects.length - visibleProjects.length;

  const setInputPath = setTypedPath;

  return (
    <View style={[styles.globalContainer, { backgroundColor: theme.colors.surface0 }]}>
      {/* Path Input Bar */}
      <View
        style={[
          styles.globalPathBar,
          layout.compact && styles.globalPathBarCompact,
          {
            backgroundColor: theme.colors.surface1,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text
          style={[styles.globalPathLabel, { color: theme.colors.foregroundMuted }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          프로젝트 경로:
        </Text>
        <TextInput
          style={[
            styles.globalPathInput,
            layout.compact && styles.globalPathInputCompact,
            {
              backgroundColor: theme.colors.surface0,
              borderColor: theme.colors.border,
              color: theme.colors.foreground,
            },
          ]}
          value={inputPath}
          onChangeText={setInputPath}
          onSubmitEditing={handleApplyPath}
          placeholder="데몬의 프로젝트 경로"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="프로젝트 경로로 세션 조회"
          onPress={handleApplyPath}
          style={({ pressed }) => [
            styles.globalPathButton,
            layout.compact && styles.globalPathButtonCompact,
            {
              backgroundColor: theme.colors.accent,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={[styles.globalPathButtonText, { color: theme.colors.accentForeground }]}>
            조회
          </Text>
        </Pressable>
      </View>

      {projects.length > 0 ? (
        <View style={styles.globalProjectRow}>
          {visibleProjects.map((project) => {
            const selected = project.cwd === activePath;
            const label = project.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || project.cwd;
            return (
              <Pressable
                key={project.cwd}
                accessibilityRole="button"
                accessibilityLabel={`프로젝트 선택: ${project.cwd}`}
                onPress={() => handlePickProject(project.cwd)}
                style={({ pressed }) => [
                  styles.globalProjectChip,
                  {
                    backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={[
                    styles.globalProjectChipText,
                    { color: selected ? theme.colors.accentForeground : theme.colors.foreground },
                  ]}
                >
                  {label} · {project.sessionCount}
                </Text>
              </Pressable>
            );
          })}
          {hiddenProjectCount > 0 || projectsExpanded ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={projectsExpanded ? "프로젝트 목록 접기" : `프로젝트 더 보기 ${hiddenProjectCount}개`}
              onPress={() => setProjectsExpanded(!projectsExpanded)}
              style={({ pressed }) => [
                styles.globalProjectChip,
                {
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.border,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text style={[styles.globalProjectChipText, { color: theme.colors.foregroundMuted }]}>
                {projectsExpanded ? "접기" : `+${hiddenProjectCount}`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <DagMainView cwd={activePath} theme={theme} compact={layout.compact} />
    </View>
  );
}

// ============================================================================
// Styles (System Tokens & 4px Grid)
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 16,
  },
  contentContainerCompact: {
    width: "100%",
    maxWidth: 390,
    alignSelf: "center",
    padding: 8,
    gap: 8,
  },
  globalContainer: {
    flex: 1,
  },
  globalPathBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  globalPathBarCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    padding: 8,
  },
  globalPathLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  globalPathInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 13,
  },
  globalPathInputCompact: {
    width: "100%",
    flex: 0,
  },
  globalPathButton: {
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  globalProjectRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  globalProjectChip: {
    // 44 keeps the chip a real touch target on a phone.
    minHeight: 44,
    justifyContent: "center",
    maxWidth: 220,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
  },
  globalProjectChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  globalPathButtonCompact: {
    width: "100%",
  },
  globalPathButtonText: {
    fontSize: 13,
    fontWeight: "600",
  },
  toolbarContainer: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
  },
  toolbarContainerCompact: {
    padding: 8,
    gap: 8,
  },
  toolbarHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolbarHeaderRowCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 8,
  },
  toolbarActionsGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  toolbarActionsGroupCompact: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  scrollNavRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  scrollNavRowCompact: {
    width: "100%",
    justifyContent: "space-between",
  },
  navMiniButton: {
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  navMiniButtonText: {
    fontSize: 11,
    fontWeight: "600",
  },
  allSessionsDropdown: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 8,
    gap: 6,
  },
  dropdownHeader: {
    fontSize: 11,
    fontWeight: "600",
  },
  dropdownScroll: {
    maxHeight: 200,
  },
  dropdownItem: {
    minHeight: 44,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 4,
    borderLeftWidth: 3,
    gap: 2,
    marginBottom: 4,
  },
  dropdownItemHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dropdownItemHeaderCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 2,
  },
  dropdownItemId: {
    maxWidth: "100%",
    flexShrink: 1,
    fontSize: 12,
    fontFamily: "monospace",
  },
  dropdownItemMeta: {
    fontSize: 11,
  },
  dropdownItemDate: {
    fontSize: 10,
  },
  toolbarTitleGroup: {
    minWidth: 0,
    flex: 1,
    marginRight: 12,
  },
  toolbarTitleGroupCompact: {
    width: "100%",
    marginRight: 0,
  },
  toolbarTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  cwdText: {
    fontSize: 11,
    marginTop: 2,
  },
  refreshButton: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    minWidth: 70,
    alignItems: "center",
    justifyContent: "center",
  },
  refreshButtonText: {
    fontSize: 12,
    fontWeight: "500",
  },
  sessionPillsScroll: {
    gap: 8,
    paddingVertical: 2,
  },
  sessionPillsScrollCompact: {
    width: "100%",
    flexDirection: "column",
  },
  sessionPill: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    minWidth: 140,
    gap: 4,
  },
  sessionPillCompact: {
    width: "100%",
    minWidth: 0,
  },
  sessionPillHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  latestTag: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
  },
  latestTagText: {
    fontSize: 10,
    fontWeight: "700",
  },
  sessionPillId: {
    minWidth: 0,
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
  },
  sessionPillMeta: {
    fontSize: 11,
  },
  statsBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "space-around",
  },
  statsBarCompact: {
    width: "100%",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 4,
  },
  statItem: {
    alignItems: "center",
    gap: 2,
  },
  statItemCompact: {
    minHeight: 44,
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  statLabel: {
    fontSize: 11,
    fontWeight: "500",
  },
  statValue: {
    fontSize: 14,
    fontWeight: "700",
  },
  statDivider: {
    width: 1,
    height: 20,
  },
  statDividerCompact: {
    width: "100%",
    height: 1,
  },
  stateCard: {
    padding: 24,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  stateCardCompact: {
    padding: 16,
    gap: 6,
  },
  stateTitle: {
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  stateDesc: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  retryButton: {
    minHeight: 44,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: "600",
  },
  sectionContainer: {
    width: "100%",
    maxWidth: "100%",
    gap: 12,
  },
  sectionHeaderRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionHeaderRowCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  runCard: {
    width: "100%",
    maxWidth: "100%",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    gap: 12,
    overflow: "hidden",
  },
  runCardCompact: {
    padding: 8,
    gap: 8,
  },
  runCardHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  runCardHeaderCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: 8,
  },
  runTitleGroup: {
    minWidth: 0,
    flex: 1,
    gap: 4,
    marginRight: 8,
  },
  runTitleGroupCompact: {
    width: "100%",
    marginRight: 0,
  },
  runTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  runTitleRowCompact: {
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
  },
  runNameText: {
    maxWidth: "100%",
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  runMetaText: {
    fontSize: 11,
  },
  expandToggleGlyph: {
    fontSize: 12,
    fontWeight: "500",
  },
  progressBarContainer: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    flexDirection: "row",
  },
  progressBarSegment: {
    height: "100%",
  },
  graphContainer: {
    gap: 12,
    marginTop: 4,
  },
  graphContainerCompact: {
    width: "100%",
    maxWidth: "100%",
  },
  graphScroll: {
    borderRadius: 6,
  },
  graphScrollContent: {
    paddingVertical: 4,
  },
  graphCanvas: {
    position: "relative",
    borderRadius: 6,
    borderWidth: 1,
    overflow: "hidden",
  },
  edgeSegment: {
    position: "absolute",
  },
  edgeArrowhead: {
    position: "absolute",
    fontSize: 9,
    lineHeight: 9,
  },
  graphNodeCard: {
    position: "absolute",
    borderRadius: 6,
    padding: 8,
    justifyContent: "space-between",
  },
  graphNodeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  graphNodeLabel: {
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  graphNodeFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
  },
  graphNodeId: {
    fontSize: 10,
    fontFamily: "monospace",
    flex: 1,
  },
  graphInstructionText: {
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 4,
  },
  nodeInspectorContainer: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 12,
    gap: 10,
    marginTop: 4,
  },
  nodeInspectorHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  nodeInspectorHeaderCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 8,
  },
  nodeInspectorTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  inspectorCloseButton: {
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: "center",
  },
  inspectorCloseText: {
    fontSize: 11,
    fontWeight: "500",
  },
  statusGlyphBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  statusGlyphText: {
    fontSize: 12,
    fontWeight: "700",
  },
  nodeTitleGroup: {
    flex: 1,
  },
  nodeIdSub: {
    fontSize: 11,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  nodeErrorBox: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  nodeErrorTitle: {
    fontSize: 11,
    fontWeight: "600",
  },
  nodeErrorText: {
    fontSize: 12,
    lineHeight: 16,
  },
  detailItem: {
    gap: 2,
  },
  detailLabel: {
    fontSize: 11,
  },
  detailValue: {
    fontSize: 12,
    lineHeight: 16,
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  detailGridCompact: {
    width: "100%",
    flexDirection: "column",
    flexWrap: "nowrap",
    gap: 8,
  },
  detailGridItem: {
    minWidth: 90,
    gap: 2,
  },
  detailGridItemCompact: {
    width: "100%",
    minWidth: 0,
  },
  liveProgressBox: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  liveProgressLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  liveProgressText: {
    fontSize: 12,
    lineHeight: 16,
  },
  taskIdFooter: {
    fontSize: 10,
    fontFamily: "monospace",
  },
  tasksList: {
    gap: 8,
  },
  taskCard: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 10,
    gap: 8,
  },
  taskCardCompact: {
    padding: 6,
    gap: 4,
  },
  taskCardHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  taskCardHeaderCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: 8,
  },
  taskHeaderLeft: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  taskHeaderLeftCompact: {
    width: "100%",
  },
  taskTitleGroup: {
    minWidth: 0,
    flex: 1,
  },
  taskDescriptionText: {
    fontSize: 13,
    fontWeight: "600",
  },
  taskIdSub: {
    fontSize: 11,
  },
  taskHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  taskHeaderRightCompact: {
    width: "100%",
    justifyContent: "space-between",
  },
  taskDetailsContainer: {
    borderTopWidth: 1,
    paddingTop: 8,
    gap: 8,
  },
  childTasksContainer: {
    marginTop: 6,
    gap: 6,
  },
  childTasksHeader: {
    fontSize: 11,
    fontWeight: "500",
    marginBottom: 2,
  },
});
