import { describe, expect, it } from "vitest";
import { currentRow, type DagRow } from "./row.js";

/**
 * The chat shows ONE graph: the run being worked on right now. Publishing a
 * card per run buried the live one under finished ones, which on a phone means
 * scrolling past history to find the thing that is actually happening.
 */
const row = (runId: string, status: string, updatedAt: string): DagRow => ({
  runId,
  name: runId,
  status,
  updatedAt,
  total: 3,
  completed: 1,
  running: status === "running" ? 1 : 0,
  failed: 0,
  layers: [[{ id: "a", label: "a", state: "completed" }]],
  edges: [],
  truncated: false,
});

describe("currentRow", () => {
  it("has nothing to show when no run was read", () => {
    expect(currentRow([])).toBeUndefined();
  });

  it("prefers the run that is still working, even over a newer finished one", () => {
    const picked = currentRow([
      row("old-running", "running", "2026-09-15T01:00:00.000Z"),
      row("new-done", "completed", "2026-09-15T02:00:00.000Z"),
    ]);

    expect(picked?.runId).toBe("old-running");
  });

  it("picks the most recent among several live runs", () => {
    const picked = currentRow([
      row("first", "running", "2026-09-15T01:00:00.000Z"),
      row("second", "running", "2026-09-15T03:00:00.000Z"),
      row("third", "running", "2026-09-15T02:00:00.000Z"),
    ]);

    expect(picked?.runId).toBe("second");
  });

  it("still shows the latest finished run when nothing is live, so the last state lands", () => {
    const picked = currentRow([
      row("older", "completed", "2026-09-15T01:00:00.000Z"),
      row("newer", "failed", "2026-09-15T02:00:00.000Z"),
    ]);

    expect(picked?.runId).toBe("newer");
  });

  it("counts a queued run as live, because it is the one about to work", () => {
    const picked = currentRow([
      row("queued", "pending", "2026-09-15T01:00:00.000Z"),
      row("finished", "completed", "2026-09-15T02:00:00.000Z"),
    ]);

    expect(picked?.runId).toBe("queued");
  });
});
