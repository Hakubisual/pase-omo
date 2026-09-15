import { describe, expect, it } from "vitest";
import type { DagSession } from "../shared/dag.js";
import { buildFolderTree } from "./folders.js";

/**
 * A closed folder is the only thing the user sees before opening it, so its
 * count has to describe the session, not how much of it happens to be loaded.
 * The panel fetches one session's snapshot at a time; every other folder would
 * otherwise claim to be empty.
 */
const session = (id: string, runCount: number, taskCount: number): DagSession => ({
  id,
  cwd: "E:/DEV/om-pase-o",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T01:00:00.000Z",
  runCount,
  taskCount,
});

describe("buildFolderTree counts", () => {
  it("shows a session's own run and task counts while its contents are unloaded", () => {
    const tree = buildFolderTree([session("s-1", 2, 7)], [], []);
    const folder = tree.root.children.find((child) => child.sessionId === "s-1");

    expect(folder).toBeDefined();
    expect(folder?.count).toBe(9);
  });

  it("prefers what is actually loaded over the session's summary", () => {
    const runs = [
      {
        id: "run-1",
        name: "run one",
        status: "running" as const,
        createdAt: "2026-09-15T00:10:00.000Z",
        updatedAt: "2026-09-15T00:20:00.000Z",
        nodes: [],
        edges: [],
      },
    ];
    // The panel loads one session at a time and says which one, exactly as here.
    const tree = buildFolderTree([session("s-1", 1, 0)], runs, [], { sessionId: "s-1" });
    const folder = tree.root.children.find((child) => child.sessionId === "s-1");

    expect(folder?.children.length).toBe(1);
    expect(folder?.count).toBe(1);
  });
});
