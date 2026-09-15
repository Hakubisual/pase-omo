import { describe, expect, it } from "vitest";
import { nodeTransition } from "./graph-visual";

/**
 * A node that changes state has to announce the change on screen, and the
 * renderer drives that from one description rather than from scattered
 * conditionals. The description is what these assertions pin.
 */
describe("nodeTransition", () => {
  it("animates when a node starts running", () => {
    const t = nodeTransition("pending", "running");

    expect(t.animate).toBe(true);
    expect(t.durationMs).toBeGreaterThan(0);
    expect(t.from.opacity).toBeLessThan(t.to.opacity);
    expect(t.to.opacity).toBe(1);
    expect(t.to.scale).toBe(1);
  });

  it("animates a completion with a settle rather than a flash", () => {
    const t = nodeTransition("running", "completed");

    expect(t.animate).toBe(true);
    // Growing into place reads as "finished"; shrinking reads as "removed".
    expect(t.from.scale).toBeLessThanOrEqual(1);
    expect(t.to.scale).toBe(1);
  });

  it("marks a failure so the renderer can emphasise it harder", () => {
    const t = nodeTransition("running", "failed");

    expect(t.animate).toBe(true);
    expect(t.emphasis).toBe("alert");
  });

  it("does not animate when the state did not change", () => {
    const t = nodeTransition("running", "running");

    expect(t.animate).toBe(false);
    expect(t.from.opacity).toBe(1);
    expect(t.from.scale).toBe(1);
    expect(t.to.opacity).toBe(1);
    expect(t.to.scale).toBe(1);
  });

  it("treats a first appearance as an entrance", () => {
    const t = nodeTransition(undefined, "pending");

    expect(t.animate).toBe(true);
    expect(t.emphasis).toBe("enter");
    expect(t.from.opacity).toBeLessThan(1);
  });
});
