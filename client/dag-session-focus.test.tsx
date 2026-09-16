/**
 * The DAG dashboard kept losing the session a user was watching: sessions are
 * listed newest first, so every session created during a run pushed the watched
 * one out of view, and the manual refresh button flickered on every background
 * poll. These cover the rules that fix that — the selection is sticky, the
 * scroller only moves when the selection actually left the viewport, empty
 * sessions can be filtered out, and polling never drives the refresh button.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type React from "react";
import { expect, test, vi } from "vitest";

import type { DagSession } from "../shared/dag.js";

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

const {
  SessionSelectorBar,
  SessionStatsBar,
  calculateSessionStats,
  calculateWorkspaceStats,
  latestSessionId,
  recallSelectedSession,
  rememberSelectedSession,
  resolveSelectedSession,
  scrollOffsetForVisibility,
  visibleSessions,
} = await import("./dag.js");

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

function session(id: string, overrides: Partial<DagSession> = {}): DagSession {
  return {
    id,
    cwd: "E:/project",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    taskCount: 0,
    runCount: 0,
    ...overrides,
  };
}

function renderedText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (node === null || typeof node !== "object") return "";
  return renderedText((node as React.ReactElement<Record<string, unknown>>).props?.children);
}

function elements(node: unknown): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object") return [];
  const element = node as React.ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children)];
}

test("a session created during a run does not steal the selection", () => {
  const watched = session("session-watched", { createdAt: "2026-09-15T01:00:00.000Z", runCount: 2 });
  const newer = session("session-newer", { createdAt: "2026-09-15T02:00:00.000Z" });

  expect(resolveSelectedSession([newer, watched], watched.id)).toBe(watched.id);
  // Only a selection that stopped existing hands the list its default back.
  expect(resolveSelectedSession([newer], watched.id)).toBe(newer.id);
  expect(resolveSelectedSession([], watched.id)).toBeNull();
  expect(resolveSelectedSession([newer, watched], null)).toBe(newer.id);
});

test("the remembered session is per workspace and never leaks between them", () => {
  rememberSelectedSession("E:/project-a", "session-a");
  rememberSelectedSession("E:/project-b", "session-b");

  expect(recallSelectedSession("E:/project-a")).toBe("session-a");
  expect(recallSelectedSession("E:/project-b")).toBe("session-b");
  expect(recallSelectedSession("E:/project-c")).toBeNull();

  rememberSelectedSession("E:/project-a", null);
  expect(recallSelectedSession("E:/project-a")).toBeNull();
  expect(recallSelectedSession("E:/project-b")).toBe("session-b");
});

test("the scroller moves only when the selected pill left the viewport", () => {
  const viewport = { offset: 0, size: 300 };

  // Fully visible: the user's own scroll position must survive the refresh.
  expect(scrollOffsetForVisibility({ start: 40, size: 140 }, viewport)).toBeNull();
  // Pushed off the right edge by newer sessions.
  expect(scrollOffsetForVisibility({ start: 400, size: 140 }, viewport)).toBe(252);
  // Scrolled past on the left.
  expect(scrollOffsetForVisibility({ start: 100, size: 140 }, { offset: 200, size: 300 })).toBe(88);
  // Nothing measured yet.
  expect(scrollOffsetForVisibility({ start: 0, size: 0 }, viewport)).toBeNull();
});

test("the activity filter hides empty sessions but never the selected one", () => {
  const empty = session("session-empty", { createdAt: "2026-09-15T03:00:00.000Z" });
  const withHistory = session("session-history", { taskCount: 4 });
  const running = session("session-running", { runCount: 1, runningCount: 1 });
  const all = [empty, withHistory, running];

  expect(visibleSessions(all, false, null).map((item) => item.id)).toEqual([
    "session-empty",
    "session-history",
    "session-running",
  ]);
  expect(visibleSessions(all, true, null).map((item) => item.id)).toEqual([
    "session-history",
    "session-running",
  ]);
  expect(visibleSessions(all, true, empty.id).map((item) => item.id)).toEqual([
    "session-empty",
    "session-history",
    "session-running",
  ]);
});

test("the latest tag follows creation time, not the position in a filtered list", () => {
  const older = session("session-older", { createdAt: "2026-09-15T00:00:00.000Z" });
  const newest = session("session-newest", { createdAt: "2026-09-16T00:00:00.000Z" });

  expect(latestSessionId([older, newest])).toBe("session-newest");
  expect(latestSessionId([])).toBeNull();
});

test("counters say which scope they describe and report the workspace separately", () => {
  const sessions = [
    session("session-a", { runCount: 2, taskCount: 3, runningCount: 1 }),
    session("session-b"),
  ];
  const workspace = calculateWorkspaceStats(sessions);

  expect(workspace).toEqual({
    sessionCount: 2,
    activeSessionCount: 1,
    totalRuns: 2,
    totalTasks: 3,
    runningCount: 1,
  });

  // An empty selected session keeps its own zeroes while the workspace line
  // shows that the work is elsewhere.
  const bar = SessionStatsBar({
    stats: calculateSessionStats({ sessionId: "session-b", runs: [], tasks: [] }),
    scopeLabel: "Selected session",
    workspace,
    theme,
    compact: false,
  });
  const text = renderedText(bar);

  expect(text).toContain("Selected session");
  expect(text).toContain("Whole workspace: 2 sessions · 2 DAG runs · 3 tasks");
});

test("the refresh button only spins for a refresh the user asked for", () => {
  const props = {
    cwd: "E:/project",
    sessions: [session("session-a", { runCount: 1 })],
    selectedSessionId: "session-a",
    onSelectSession: () => {},
    onRefresh: () => {},
    theme,
    compact: false,
  };

  const polling = SessionSelectorBar({ ...props, isRefreshing: false });
  expect(renderedText(polling)).toContain("⟳ Refresh");
  expect(
    elements(polling).some(
      (element) =>
        (element.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true,
    ),
  ).toBe(false);

  const manual = SessionSelectorBar({ ...props, isRefreshing: true });
  expect(renderedText(manual)).not.toContain("⟳ Refresh");
});
