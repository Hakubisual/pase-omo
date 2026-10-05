import { describe, expect, it } from "vitest";
import { foldWakeEvent, isOccupied, type OccupancyInput, type WakeSnapshot } from "./occupancy";

const idle: OccupancyInput = {
  wakes: [],
  flags: {},
  openTasks: 0,
  openWorkpoolItems: 0,
  openDagRuns: 0,
  openMonitors: 0,
  openQuestions: 0,
  openBashSessions: 0,
};

const wakeEvent = (data: unknown) => ({ type: "extension_event", name: "wake_source_state", data });

describe("foldWakeEvent", () => {
  it("adds a source when activeCount > 0 and keeps well-formed items only", () => {
    const next = foldWakeEvent(new Map(), wakeEvent({
      source: "task",
      activeCount: 2,
      items: [{ id: "a", description: "x" }, { id: "" }, { id: 3 }, "bad", { id: "b" }],
    }));
    expect(next.get("task")).toEqual({
      source: "task",
      activeCount: 2,
      items: [{ id: "a", description: "x" }, { id: "b" }],
    });
  });

  it("replaces an existing source", () => {
    const current = new Map<string, WakeSnapshot>([["task", { source: "task", activeCount: 1 }]]);
    const next = foldWakeEvent(current, wakeEvent({ source: "task", activeCount: 3 }));
    expect(next.get("task")).toEqual({ source: "task", activeCount: 3 });
  });

  it("deletes a source when activeCount <= 0", () => {
    const current = new Map<string, WakeSnapshot>([["task", { source: "task", activeCount: 1 }]]);
    expect(foldWakeEvent(current, wakeEvent({ source: "task", activeCount: 0 })).size).toBe(0);
    expect(foldWakeEvent(current, wakeEvent({ source: "task", activeCount: -1 })).size).toBe(0);
  });

  it("does not delete an existing source on malformed events", () => {
    const current = new Map<string, WakeSnapshot>([["task", { source: "task", activeCount: 1 }]]);
    const malformed = [
      wakeEvent({ source: "task", activeCount: "0" }),
      wakeEvent({ source: "task", activeCount: Number.NaN }),
      wakeEvent({ source: "", activeCount: 0 }),
      wakeEvent({ activeCount: 0 }),
      wakeEvent(null),
      { type: "other", name: "wake_source_state", data: { source: "task", activeCount: 0 } },
      { type: "extension_event", name: "other", data: { source: "task", activeCount: 0 } },
    ];
    for (const event of malformed) {
      const next = foldWakeEvent(current, event);
      expect(next).toEqual(current);
      expect(next).not.toBe(current);
    }
  });

  it("never mutates the input map", () => {
    const current = new Map<string, WakeSnapshot>([["task", { source: "task", activeCount: 1 }]]);
    foldWakeEvent(current, wakeEvent({ source: "task", activeCount: 0 }));
    foldWakeEvent(current, wakeEvent({ source: "dag", activeCount: 1 }));
    expect([...current.keys()]).toEqual(["task"]);
  });
});

describe("isOccupied", () => {
  it("is false when idle, with zero or missing flags", () => {
    expect(isOccupied(idle)).toBe(false);
    expect(isOccupied({
      ...idle,
      wakes: [{ source: "t", activeCount: 0 }],
      flags: { isStreaming: false, pendingMessageCount: 0, retryAttempt: 0, queuedInputs: 0 },
    })).toBe(false);
  });

  it.each([
    ["wake", { wakes: [{ source: "t", activeCount: 1 }] }],
    ["isStreaming", { flags: { isStreaming: true } }],
    ["isBashRunning", { flags: { isBashRunning: true } }],
    ["isCompacting", { flags: { isCompacting: true } }],
    ["pendingMessageCount", { flags: { pendingMessageCount: 1 } }],
    ["retryAttempt", { flags: { retryAttempt: 1 } }],
    ["queuedInputs", { flags: { queuedInputs: 1 } }],
    ["openTasks", { openTasks: 1 }],
    ["openWorkpoolItems", { openWorkpoolItems: 1 }],
    ["openDagRuns", { openDagRuns: 1 }],
    ["openMonitors", { openMonitors: 1 }],
    ["openQuestions", { openQuestions: 1 }],
    ["openBashSessions", { openBashSessions: 1 }],
  ] satisfies [string, Partial<OccupancyInput>][])("is true for %s", (_name, patch) => {
    expect(isOccupied({ ...idle, ...patch })).toBe(true);
  });
});
