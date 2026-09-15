import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DagRun, DagSession, DagTask } from "../shared/dag.js";
import { buildFolderTree, defaultExpanded, expandAll, folderKey, toggleFolder } from "./folders.js";
import { FolderBrowser } from "./folders-browser.js";

const theme: PluginTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f8fafc",
    surface2: "#eef2f6",
    border: "#d8dee8",
    foreground: "#111827",
    foregroundMuted: "#64748b",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    statusSuccess: "#16a34a",
    statusWarning: "#d97706",
    statusDanger: "#dc2626",
  },
};

type ElementProps = {
  accessibilityLabel?: string;
  children?: ReactNode;
  numberOfLines?: number;
  onPress?: () => void | Promise<void>;
  style?: unknown;
  testID?: string;
};

function descendants(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!React.isValidElement<ElementProps>(node)) return [];
  return [node, ...descendants(node.props.children)];
}

function control(tree: ReactNode, label: string): ReactElement<ElementProps> {
  const found = descendants(tree).find((element) => element.props.accessibilityLabel === label);
  if (!found) throw new Error(`Missing control: ${label}`);
  return found;
}

function textElement(tree: ReactNode, text: string): ReactElement<ElementProps> {
  const found = descendants(tree).find((element) => element.props.children === text);
  if (!found) throw new Error(`Missing text: ${text}`);
  return found;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}

async function press(tree: ReactNode, label: string): Promise<void> {
  const onPress = control(tree, label).props.onPress;
  if (!onPress) throw new Error(`Control is not pressable: ${label}`);
  await onPress();
}

const session = (partial: Partial<DagSession> & Pick<DagSession, "id" | "title">): DagSession => ({
  cwd: "E:/project",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T01:00:00.000Z",
  taskCount: 0,
  runCount: 0,
  ...partial,
});

const run = (partial: Partial<DagRun> & Pick<DagRun, "id" | "name">): DagRun => ({
  status: "completed",
  createdAt: "2026-09-10T00:05:00.000Z",
  updatedAt: "2026-09-10T00:30:00.000Z",
  nodes: [],
  edges: [],
  ...partial,
});

const task = (partial: Partial<DagTask> & Pick<DagTask, "id">): DagTask => ({
  description: partial.id,
  status: "completed",
  ...partial,
});

type BrowserProps = Parameters<typeof FolderBrowser>[0];

function render(partial: Partial<BrowserProps> = {}): ReactNode {
  return FolderBrowser({
    tree: partial.tree ?? buildFolderTree([], [], []),
    expanded: partial.expanded ?? new Set([folderKey.root]),
    theme,
    layout: partial.layout ?? { compact: false, platform: "web" },
    onToggle: partial.onToggle ?? (() => {}),
    onOpenSession: partial.onOpenSession ?? (() => {}),
  });
}

const sessions = [session({ id: "s-old", title: "세션 오래된" }), session({ id: "s-new", title: "세션 최신" })];
const scoped = {
  sessions,
  runs: [
    run({
      id: "r1",
      name: "런 하나",
      nodes: [{ id: "n1", label: "잎", state: "completed", attempt: 0, taskId: "st_leaf", error: "" }],
      edges: [],
    }),
  ],
  tasks: [task({ id: "st_leaf", description: "잎 작업" })],
} as const;

function fixtureTree() {
  return buildFolderTree(scoped.sessions, [...scoped.runs], [...scoped.tasks], { sessionId: "s-new" });
}

describe("FolderBrowser", () => {
  it("renders an explicit empty state for empty input", () => {
    const tree = render({ tree: buildFolderTree([], [], []) });

    expect(textElement(tree, "Empty folder")).toBeDefined();
    expect(textElement(tree, "No sessions, runs, or tasks recorded yet.")).toBeDefined();
    expect(descendants(tree).some((element) => element.props.accessibilityLabel === "Toggle folder All")).toBe(false);
  });

  it("renders one row per visible folder at desktop width", () => {
    const tree = fixtureTree();
    const ui = render({ tree, expanded: defaultExpanded(tree) });

    for (const label of ["All", "세션 최신", "세션 오래된", "런 하나"]) {
      expect(textElement(ui, label)).toBeDefined();
    }
    // A collapsed run hides its task leaves until it is expanded.
    expect(descendants(ui).some((element) => element.props.children === "잎 작업")).toBe(false);

    const sessionRow = flattenStyle(control(ui, "Toggle folder 세션 최신").props.style);
    const runRow = flattenStyle(control(ui, "Toggle folder 런 하나").props.style);
    expect(sessionRow.paddingLeft).toBe(12);
    expect(runRow.paddingLeft).toBe(24);
  });

  it("toggling calls onToggle with only the targeted folder key", async () => {
    const tree = fixtureTree();
    const onToggle = vi.fn<(key: string) => void>();
    const ui = render({ tree, expanded: defaultExpanded(tree), onToggle });

    await press(ui, "Toggle folder 세션 최신");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(folderKey.session("s-new"));

    await press(ui, "Toggle folder 런 하나");
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith(folderKey.run("s-new", "r1"));

    expect(onToggle).not.toHaveBeenCalledWith(folderKey.session("s-old"));
  });

  it("pressing a task leaf opens that leaf's session", async () => {
    const tree = fixtureTree();
    const onOpenSession = vi.fn<(sessionId: string) => void>();
    const expanded = toggleFolder(defaultExpanded(tree), folderKey.run("s-new", "r1"));
    const ui = render({ tree, expanded, onOpenSession });

    await press(ui, "Open 잎 작업");
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("s-new");
  });

  it("keeps every folder label legible inside a compact 390px viewport", () => {
    const longTitle = "아주 긴 세션 제목으로 390픽셀 전화 화면에서 잘리는지 확인하는 라벨";
    const longTask = "390픽셀 컴팩트 레이아웃에서 이 작업 라벨이 한 줄 말줄임으로 잘리는지 검증하기 위한 긴 설명";
    const tree = buildFolderTree(
      [session({ id: "s-long", title: longTitle })],
      [
        run({
          id: "r-long",
          name: "긴 런 이름도 말줄임 대상입니다",
          nodes: [{ id: "n1", label: "긴", state: "running", attempt: 0, taskId: "st_long", error: "" }],
        }),
      ],
      [task({ id: "st_long", description: longTask })],
      { sessionId: "s-long" },
    );
    const ui = render({ tree, expanded: expandAll(tree), layout: { compact: true, platform: "ios" } });

    for (const label of ["All", longTitle, "긴 런 이름도 말줄임 대상입니다", longTask]) {
      const element = textElement(ui, label);
      expect(element.props.numberOfLines).toBeGreaterThanOrEqual(1);
      expect(flattenStyle(element.props.style)).toMatchObject({ maxWidth: "100%", flexShrink: 1 });
    }

    for (const label of ["Toggle folder All", `Toggle folder ${longTitle}`, "Toggle folder 긴 런 이름도 말줄임 대상입니다"]) {
      const style = flattenStyle(control(ui, label).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }

    for (const element of descendants(ui)) {
      const style = flattenStyle(element.props.style);
      if (typeof style.width === "number") expect(style.width).toBeLessThanOrEqual(390);
      if (typeof style.maxWidth === "number") expect(style.maxWidth).toBeLessThanOrEqual(390);
    }
  });

  it("renders the compact empty state full width without overflow", () => {
    const ui = render({ tree: buildFolderTree([], [], []), layout: { compact: true, platform: "ios" } });

    const empty = descendants(ui).find((element) => element.props.testID === "folders-empty");
    expect(empty).toBeDefined();
    expect(flattenStyle(empty?.props.style)).toMatchObject({ width: "100%", maxWidth: 390, overflow: "hidden" });
    expect(textElement(ui, "Empty folder")).toBeDefined();
  });
});
