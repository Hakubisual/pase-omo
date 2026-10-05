import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectWatchChildren, readBackgroundSessions, readOpenWork, type WatchChildState } from "./background-watch";

const SESSION = "ses_me";
const POOL = `wp_${"a".repeat(32)}`;

let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "bgwatch-"));
  env = { PASEO_OMO_TASK_STATE_DIR: join(cwd, "state") };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function putPool(pool: Record<string, unknown>, file = `${POOL}.json`): Promise<void> {
  const dir = join(cwd, "state", "workpools");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), typeof pool === "string" ? pool : JSON.stringify(pool));
}

describe("readOpenWork", () => {
  it("lists a queued item and skips st_-bound, finished and other-session work", async () => {
    await putPool({
      pool_id: "p1",
      name: "Pool One",
      parent_session_id: SESSION,
      status: "running",
      items: [
        { key: "alpha", status: "queued", item_id: "it-1" },
        { key: "beta", status: "assigned", binding: { task_id: "st_abc" } },
        { key: "gamma", status: "assigned" },
        { key: "delta", status: "done" },
      ],
    });
    await putPool(
      { pool_id: "p2", parent_session_id: "other", root_session_id: "other", items: [{ key: "x", status: "queued" }] },
      `wp_${"b".repeat(32)}.json`,
    );
    expect(await readOpenWork(cwd, SESSION, env)).toEqual([
      { kind: "workpool", id: "it-1", title: "alpha", description: "Pool One" },
      { kind: "workpool", id: "wp-p1-gamma", title: "gamma", description: "Pool One" },
    ]);
  });

  it("is empty when the directories are missing", async () => {
    expect(await readOpenWork(cwd, SESSION, env)).toEqual([]);
  });

  it("reports unreadable for a corrupt workpool file", async () => {
    const dir = join(cwd, "state", "workpools");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${POOL}.json`), "{not json");
    expect(await readOpenWork(cwd, SESSION, env)).toBe("unreadable");
  });

  it("lists a non-terminal dag run and skips a terminal one", async () => {
    const dir = join(cwd, "state", "dag", "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "r1.json"), JSON.stringify({ runId: "r1", name: "Build", parentSessionId: SESSION, status: "running" }));
    await writeFile(join(dir, "r2.json"), JSON.stringify({ runId: "r2", parentSessionId: SESSION, status: "completed" }));
    await writeFile(join(dir, "r3.json"), JSON.stringify({ runId: "r3", parentSessionId: SESSION, status: "skipped" }));
    expect(await readOpenWork(cwd, SESSION, env)).toEqual([
      { kind: "dag", id: "r1", title: "Build", description: "Workflow Build" },
    ]);
  });
});

describe("projectWatchChildren", () => {
  const child = { id: "wp-1", title: "t", description: "d" };
  const base = { parentSessionId: "parent", cwd: "/w" };

  it("opens, stays quiet, closes, then reopens a returning child", () => {
    const opened = projectWatchChildren({ ...base, live: [child, { ...child, id: "st_x" }], previous: new Map() });
    expect(opened.events.map((e) => e.type)).toEqual(["session.opened", "timeline.item", "session.turn"]);
    expect(opened.events[0]).toMatchObject({ sessionId: "wp-1", parentSessionId: "parent", title: "t", description: "d", cwd: "/w" });
    expect([...opened.state.keys()]).toEqual(["wp-1"]);

    const quiet = projectWatchChildren({ ...base, live: [child], previous: opened.state });
    expect(quiet.events).toEqual([]);

    const closed = projectWatchChildren({ ...base, live: [], previous: opened.state });
    expect(closed.events.map((e) => e.type)).toEqual(["timeline.item", "session.turn", "session.closed"]);
    expect(closed.state.get("wp-1")).toEqual({ opened: true, closed: true });
    expect(opened.state.get("wp-1")).toEqual({ opened: true, closed: false });

    const again = projectWatchChildren({ ...base, live: [], previous: closed.state });
    expect(again.events).toEqual([]);

    const reopened = projectWatchChildren({ ...base, live: [child], previous: closed.state as ReadonlyMap<string, WatchChildState> });
    expect(reopened.events.map((e) => e.type)).toEqual(["session.opened", "timeline.item", "session.turn"]);
    expect(reopened.state.get("wp-1")).toEqual({ opened: true, closed: false });
  });
});

describe("readBackgroundSessions", () => {
  it("reads a sidecar next to the session file and ignores a missing one", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-bash-"));
    try {
      const sessionFile = join(root, "stamp_ses.jsonl");
      expect(await readBackgroundSessions(sessionFile, "ses")).toEqual({ sessions: [], count: 0 });

      const dir = join(root, "extensions", "terminal");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${encodeURIComponent("ses")}.json`),
        JSON.stringify({
          backgroundSessions: [
            { id: "bash-1", command: "sleep 30", startedAtMs: 1 },
            { id: "st_skip" },
          ],
        }),
      );
      expect(await readBackgroundSessions(sessionFile, "ses")).toEqual({
        count: 2,
        sessions: [{ id: "bash-1", title: "sleep 30", description: "Background bash: sleep 30" }],
      });

      await writeFile(join(dir, `${encodeURIComponent("ses")}.json`), "{");
      expect(await readBackgroundSessions(sessionFile, "ses")).toBe("unreadable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
