import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import type React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { DagSession, DagSnapshotPayload } from "../shared/dag.js";

const harness = vi.hoisted(() => ({
  queries: [] as Array<Record<string, unknown>>,
  sessions: [] as DagSession[],
  snapshot: null as DagSnapshotPayload | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: () => {},
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      () => {},
    ],
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    harness.queries.push(options);
    const key = options.queryKey as readonly unknown[];
    const data = key[1] === "sessions" ? { sessions: harness.sessions } : harness.snapshot;
    return {
      data,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async () => ({}),
  useWorkspace: () => "E:/project",
}));

import { DagGlobalSurface, DagMainView, DagPanel, DagRunCard, SessionSelectorBar } from "./dag.js";

const theme: PluginTheme = {
  colors: {
    surface0: "#fff",
    surface1: "#f8f8f8",
    surface2: "#eee",
    border: "#ddd",
    foreground: "#111",
    foregroundMuted: "#777",
    accent: "#1677ff",
    accentForeground: "#fff",
    statusSuccess: "#0a0",
    statusWarning: "#a60",
    statusDanger: "#c00",
  },
};

const currentSession: DagSession = {
  id: "session-current",
  cwd: "E:/project",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:10:00.000Z",
  taskCount: 0,
  runCount: 1,
};

const otherSession: DagSession = {
  id: "session-other",
  cwd: "E:/project",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:10:00.000Z",
  taskCount: 0,
  runCount: 1,
};

const hostProps = {
  theme,
  host: { id: "host-1", label: "Host" },
  layout: { compact: false, platform: "web" as const },
};

function elements(node: unknown): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object") return [];
  const element = node as React.ReactElement<Record<string, unknown>>;
  const children = elements(element.props?.children);
  return [element, ...children];
}

function renderedText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (node === null || typeof node !== "object") return "";
  return renderedText((node as React.ReactElement<Record<string, unknown>>).props?.children);
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flatStyle));
  }
  if (typeof style === "function") {
    return flatStyle((style as (state: { pressed: boolean }) => unknown)({ pressed: false }));
  }
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

beforeEach(() => {
  harness.queries = [];
  harness.sessions = [currentSession, otherSession];
  harness.snapshot = {
    sessionId: "session-current",
    runs: [],
    tasks: [],
  };
});

test("DagPanel in agent context requests its snapshot by agent id without client runtime metadata", () => {
  const props = {
    ...hostProps,
    context: "agent" as const,
    workspaceId: "workspace-1",
    agentId: "agent-1",
  } satisfies PluginAgentPanelProps;

  const panel = DagPanel(props as unknown as Parameters<typeof DagPanel>[0]);

  expect(panel.type).toBe(DagMainView);
  expect((panel.props as { agentId?: string }).agentId).toBe("agent-1");
  expect((panel.props as { cwd?: string }).cwd).toBe("");
  expect((panel.props as { sessionId?: string | null }).sessionId).toBeUndefined();
});

test("agent-scoped DagMainView queries only the current snapshot while the global view lists every session", () => {
  const agentView = DagMainView({
    cwd: "",
    theme,
    compact: false,
    agentId: "agent-1",
  } as unknown as Parameters<typeof DagMainView>[0]);

  const agentQueries = harness.queries.map((query) => query.queryKey);
  expect(agentQueries).toContainEqual(["dag", "agent-snapshot", "agent-1"]);
  expect(elements(agentView).some((element) => element.type === SessionSelectorBar)).toBe(false);

  harness.queries = [];
  const globalView = DagMainView({ cwd: "E:/project", theme, compact: false });
  const selector = elements(globalView).find((element) => element.type === SessionSelectorBar);

  expect(selector).toBeDefined();
  expect((selector?.props.sessions as DagSession[]).map((session) => session.id)).toEqual([
    "session-current",
    "session-other",
  ]);
  expect(harness.queries.map((query) => query.queryKey)).toContainEqual([
    "dag",
    "sessions",
    "E:/project",
  ]);

  const surface = DagGlobalSurface(hostProps);
  const surfaceMainView = elements(surface).find((element) => element.type === DagMainView);
  expect((surfaceMainView?.props as { agentId?: string } | undefined)?.agentId).toBeUndefined();
});

test("an empty current session renders the existing empty snapshot copy without falling back to another session", () => {
  const view = DagMainView({
    cwd: "",
    theme,
    compact: false,
    agentId: "agent-1",
  } as unknown as Parameters<typeof DagMainView>[0]);

  expect(renderedText(view)).toContain("DAG 실행 및 작업 기록 없음");
  expect(renderedText(view)).not.toContain("session-other");
});

test("compact DAG rendering keeps primary labels and touch targets inside a 390px phone viewport", () => {
  const phoneWidth = 390;
  const compactPanel = DagPanel({
    ...hostProps,
    layout: { ...hostProps.layout, compact: true },
    context: "agent",
    workspaceId: "workspace-1",
    agentId: "agent-1",
  });
  expect((compactPanel.props as { compact?: boolean }).compact).toBe(true);
  const runName = "A very long primary DAG run label that must stay readable on a phone";
  const nodeLabels = [
    "Evaluate the complete workspace without overflowing the phone",
    "Summarize all diagnostics in a mobile-readable card",
    "Publish the final result without horizontal scrolling",
  ];
  const run = {
    id: "run-mobile",
    name: runName,
    status: "running" as const,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:01:00.000Z",
    nodes: nodeLabels.map((label, index) => ({
      id: `mobile-node-${index}`,
      label,
      state: index === 0 ? ("running" as const) : ("pending" as const),
      attempt: 0,
      error: "",
    })),
    edges: [],
  };

  harness.snapshot = { sessionId: "session-current", runs: [run], tasks: [] };
  const mainView = DagMainView({
    cwd: "",
    theme,
    compact: true,
    agentId: "agent-1",
  } as unknown as Parameters<typeof DagMainView>[0]);
  const mainStyle = flatStyle(
    (mainView.props as { contentContainerStyle?: unknown }).contentContainerStyle,
  );
  expect(mainStyle.maxWidth).toBe(phoneWidth);
  expect(mainStyle.width).toBe("100%");

  const card = DagRunCard({
    run,
    tasksMap: new Map(),
    childTasksMap: new Map(),
    foldedRuns: {},
    onToggleRunFold: () => {},
    selectedNodeId: null,
    onSelectNode: () => {},
    foldedTasks: {},
    onToggleTaskFold: () => {},
    theme,
    compact: true,
  });
  const cardElements = elements(card);

  expect(renderedText(card)).toContain(runName);
  for (const label of nodeLabels) expect(renderedText(card)).toContain(label);
  // The phone draws the same node-and-edge canvas the desktop does. It used to
  // be rewritten as a flat list here, which made the mobile panel a different
  // product: a run wider than the screen now scrolls inside its own scroller.
  const horizontalScrollers = cardElements.filter(
    (element) => element.type === "ScrollView" && element.props.horizontal === true,
  );
  expect(horizontalScrollers).toHaveLength(1);
  const canvasScroller = horizontalScrollers[0];
  if (!canvasScroller) throw new Error("compact card must draw its graph canvas");
  const insideCanvas = new Set(elements(canvasScroller));

  // Only that canvas may outgrow the phone; anything else this wide would push
  // the card itself off screen instead of scrolling.
  const oversizedWidths = cardElements
    .filter((element) => !insideCanvas.has(element))
    .map((element) => flatStyle(element.props.style).width)
    .filter((width): width is number => typeof width === "number" && width > phoneWidth - 16);
  expect(oversizedWidths).toEqual([]);

  const primaryLabels = cardElements.filter(
    (element) => nodeLabels.includes(String(element.props.children)) || element.props.children === runName,
  );
  expect(primaryLabels).toHaveLength(nodeLabels.length + 1);
  for (const label of primaryLabels) {
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.ellipsizeMode).toBe("tail");
  }

  const touchTargets = cardElements.filter(
    (element) => element.type === "Pressable" && typeof element.props.accessibilityLabel === "string",
  );
  expect(touchTargets.length).toBeGreaterThanOrEqual(nodeLabels.length + 1);
  for (const target of touchTargets) {
    const style = flatStyle(target.props.style);
    const height = typeof style.height === "number" ? style.height : 0;
    const minHeight = typeof style.minHeight === "number" ? style.minHeight : 0;
    expect(Math.max(height, minHeight)).toBeGreaterThanOrEqual(44);
  }

  const localPath = "E:/project/with/a/very/long/mobile/path";
  const compactSelector = SessionSelectorBar({
    cwd: localPath,
    sessions: [currentSession, otherSession],
    selectedSessionId: currentSession.id,
    onSelectSession: () => {},
    onRefresh: () => {},
    isFetching: false,
    theme,
    compact: true,
  });
  expect(
    elements(compactSelector).some(
      (element) => element.type === "ScrollView" && element.props.horizontal === true,
    ),
  ).toBe(false);
  expect(renderedText(compactSelector)).not.toContain(localPath);
  expect(renderedText(compactSelector)).toContain("…/mobile/path");

  const desktopCard = DagRunCard({
    run,
    tasksMap: new Map(),
    childTasksMap: new Map(),
    foldedRuns: {},
    onToggleRunFold: () => {},
    selectedNodeId: null,
    onSelectNode: () => {},
    foldedTasks: {},
    onToggleTaskFold: () => {},
    theme,
    compact: false,
  });
  expect(
    elements(desktopCard).some(
      (element) => element.type === "ScrollView" && element.props.horizontal === true,
    ),
  ).toBe(true);
});
