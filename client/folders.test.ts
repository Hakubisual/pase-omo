import { describe, expect, it } from "vitest";

import type { DagRun, DagSession, DagTask } from "../shared/dag.js";
import {
  buildFolderTree,
  collapseAll,
  defaultExpanded,
  expandAll,
  folderKey,
  isExpanded,
  toggleFolder,
  visibleFolders,
  type FolderNode,
} from "./folders.js";

const session = (partial: Partial<DagSession> & Pick<DagSession, "id">): DagSession => ({
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

const leafLabels = (node: FolderNode): string[] =>
  node.children.length === 0 ? [node.label] : node.children.flatMap(leafLabels);

describe("buildFolderTree", () => {
  it("builds an explicit empty tree when nothing is recorded", () => {
    const tree = buildFolderTree([], [], []);

    expect(tree.count).toBe(0);
    expect(tree.root.children).toEqual([]);
    expect(defaultExpanded(tree)).toEqual(new Set([folderKey.root]));
  });

  it("groups sessions deterministically, newest first, regardless of input order", () => {
    const older = session({ id: "s-old", title: "오래된 세션", updatedAt: "2026-09-10T01:00:00.000Z" });
    const newer = session({ id: "s-new", title: "최근 세션", updatedAt: "2026-09-11T01:00:00.000Z" });

    const forward = buildFolderTree([older, newer], [], []);
    const shuffled = buildFolderTree([newer, older], [], []);

    expect(forward.root.children.map((node) => node.label)).toEqual(["최근 세션", "오래된 세션"]);
    expect(shuffled.root.children.map((node) => node.key)).toEqual(forward.root.children.map((node) => node.key));
  });

  it("breaks session order ties by id so equal timestamps stay stable", () => {
    const a = session({ id: "s-a", updatedAt: "2026-09-10T01:00:00.000Z" });
    const b = session({ id: "s-b", updatedAt: "2026-09-10T01:00:00.000Z" });

    const one = buildFolderTree([b, a], [], []);
    const two = buildFolderTree([a, b], [], []);

    expect(one.root.children.map((node) => node.key)).toEqual([folderKey.session("s-a"), folderKey.session("s-b")]);
    expect(two.root.children.map((node) => node.key)).toEqual(one.root.children.map((node) => node.key));
  });

  it("nests a run's tasks under the run folder following the parentTaskId chain", () => {
    const sessions = [session({ id: "s1", title: "세션 하나", taskCount: 3, runCount: 1 })];
    const tasks: DagTask[] = [
      task({ id: "st_parent", description: "부모 작업" }),
      task({ id: "st_child", description: "자식 작업", parentTaskId: "st_parent" }),
      task({ id: "st_solo", description: "단독 작업" }),
    ];
    const runs = [
      run({
        id: "r1",
        name: "릴리스 파이프라인",
        nodes: [
          { id: "n1", label: "부모", state: "completed", attempt: 0, taskId: "st_parent", error: "" },
          { id: "n2", label: "자식", state: "completed", attempt: 0, taskId: "st_child", error: "" },
          { id: "n3", label: "단독", state: "completed", attempt: 0, taskId: "st_solo", error: "" },
        ],
        edges: [{ from: "n1", to: "n2" }],
      }),
    ];

    const tree = buildFolderTree(sessions, runs, tasks, { sessionId: "s1" });
    const sessionFolder = tree.root.children[0];
    expect(sessionFolder?.kind).toBe("session");
    const runFolder = sessionFolder?.children.find((node) => node.kind === "run");
    expect(runFolder?.label).toBe("릴리스 파이프라인");

    // The child sits inside its parent, one level deeper than the solo task.
    const childLabels = leafLabels(runFolder ?? tree.root);
    expect(childLabels).toContain("자식 작업");
    expect(childLabels).toContain("단독 작업");
    const parentFolder = runFolder?.children.find((node) => node.label === "부모 작업");
    expect(parentFolder?.children.map((node) => node.label)).toEqual(["자식 작업"]);

    // Every task appears exactly once below the run folder: the parent is a
    // folder, so only its child and the solo task are leaves here.
    expect(childLabels).toHaveLength(2);
    expect(tree.count).toBe(3);
    // The run folder counts its leaf descendants, not its direct children.
    expect(runFolder?.count).toBe(3);
    expect(sessionFolder?.count).toBe(3);
  });

  it("attaches tasks that no run references directly under the session folder", () => {
    const sessions = [session({ id: "s1" })];
    const tasks = [
      task({ id: "st_lone", description: "런 없는 작업" }),
      task({ id: "st_nested", description: "중첩 작업", parentTaskId: "st_lone" }),
    ];

    const tree = buildFolderTree(sessions, [], tasks, { sessionId: "s1" });
    const sessionFolder = tree.root.children[0];

    expect(sessionFolder?.children.map((node) => node.label)).toEqual(["런 없는 작업"]);
    expect(sessionFolder?.children[0]?.children.map((node) => node.label)).toEqual(["중첩 작업"]);
    expect(tree.count).toBe(2);
  });

  it("claims a task for exactly one run, the newest first, when several runs reference it", () => {
    const sessions = [session({ id: "s1" })];
    const tasks = [task({ id: "st_shared", description: "공유 작업" })];
    const runs = [
      run({
        id: "r-first",
        name: "먼저 실행",
        createdAt: "2026-09-10T00:05:00.000Z",
        nodes: [{ id: "n1", label: "공유", state: "completed", attempt: 0, taskId: "st_shared", error: "" }],
        edges: [],
      }),
      run({
        id: "r-second",
        name: "나중 실행",
        createdAt: "2026-09-10T01:05:00.000Z",
        nodes: [{ id: "n1", label: "공유", state: "running", attempt: 1, taskId: "st_shared", error: "" }],
        edges: [],
      }),
    ];

    const tree = buildFolderTree(sessions, runs, tasks, { sessionId: "s1" });
    const sessionFolder = tree.root.children[0];
    const runFolders = sessionFolder?.children.filter((node) => node.kind === "run") ?? [];

    // Runs follow the store's order: newest first.
    expect(runFolders.map((node) => node.label)).toEqual(["나중 실행", "먼저 실행"]);
    expect(runFolders[0]?.children.map((node) => node.label)).toEqual(["공유 작업"]);
    expect(runFolders[1]?.children).toEqual([]);
    expect(tree.count).toBe(1);
  });

  it("files content that has no session scope under an explicit unfiled folder", () => {
    const tasks = [task({ id: "st_loose", description: "범위 없는 작업" })];
    const runs = [run({ id: "r-loose", name: "범위 없는 런" })];

    const tree = buildFolderTree([], runs, tasks);

    expect(tree.root.children.map((node) => node.label)).toEqual(["미분류"]);
    expect(tree.root.children[0]?.sessionId).toBe("");
    expect(tree.count).toBe(1);
  });
});

describe("folder expansion helpers", () => {
  const sessions = [session({ id: "s1" }), session({ id: "s2" })];
  const tasks = [task({ id: "st_leaf", description: "잎 작업" })];
  const runs = [
    run({
      id: "r1",
      name: "런",
      nodes: [{ id: "n1", label: "잎", state: "running", attempt: 0, taskId: "st_leaf", error: "" }],
      edges: [],
    }),
  ];
  const tree = buildFolderTree(sessions, runs, tasks, { sessionId: "s1" });

  it("starts with the root and every session expanded, runs collapsed", () => {
    const expanded = defaultExpanded(tree);

    expect(isExpanded(expanded, folderKey.root)).toBe(true);
    expect(isExpanded(expanded, folderKey.session("s1"))).toBe(true);
    expect(isExpanded(expanded, folderKey.session("s2"))).toBe(true);
    expect(isExpanded(expanded, folderKey.run("s1", "r1"))).toBe(false);
  });

  it("toggling a folder touches only that folder", () => {
    const expanded = defaultExpanded(tree);
    const next = toggleFolder(expanded, folderKey.session("s1"));

    expect(isExpanded(next, folderKey.session("s1"))).toBe(false);
    expect(isExpanded(next, folderKey.session("s2"))).toBe(true);
    expect(isExpanded(next, folderKey.root)).toBe(true);

    const restored = toggleFolder(next, folderKey.session("s1"));
    expect(restored).toEqual(expanded);
  });

  it("expandAll and collapseAll cover every folder without inventing keys", () => {
    const all = expandAll(tree);

    expect(isExpanded(all, folderKey.run("s1", "r1"))).toBe(true);
    expect(collapseAll(tree)).toEqual(new Set());
  });

  it("visibleFolders shows a collapsed folder's row but hides its subtree", () => {
    const expanded = defaultExpanded(tree);
    const collapsed = visibleFolders(tree, expanded);

    const runRow = collapsed.filter((node) => node.key === folderKey.run("s1", "r1"));
    expect(runRow).toHaveLength(1);
    expect(runRow[0]?.label).toBe("런");
    expect(runRow[0]?.depth).toBe(2);
    expect(collapsed.some((node) => node.label === "잎 작업")).toBe(false);

    const opened = toggleFolder(expanded, folderKey.run("s1", "r1"));
    const openRows = visibleFolders(tree, opened);
    const leaf = openRows.filter((node) => node.label === "잎 작업");
    expect(leaf).toHaveLength(1);
    expect(leaf[0]?.depth).toBe(3);
    expect(leaf[0]?.status).toBe("completed");
  });
});
