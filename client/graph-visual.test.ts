import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";

import { DAG_STATES, edgeVisual, nodeVisual, progressPercent, statusLabel } from "./graph-visual";

const theme = {
  colors: {
    surface0: "#101014",
    surface1: "#17171d",
    surface2: "#1f1f27",
    foreground: "#e7e7ef",
    foregroundMuted: "#9a9aa8",
    border: "#2c2c36",
    accent: "#7aa2f7",
    accentForeground: "#0b0b10",
    statusSuccess: "#54c98a",
    statusDanger: "#f2637e",
    statusWarning: "#e6b455",
  },
} as unknown as PluginTheme;

describe("nodeVisual", () => {
  it("lights the running node so a live step is unmistakable", () => {
    const running = nodeVisual("running", theme);

    expect(running.lit).toBe(true);
    expect(running.glyph).toBe("◌");
    expect(running.borderColor).toBe(theme.colors.accent);
    // A lit node carries a tint behind it, which is what reads as "on".
    expect(running.backgroundColor).not.toBe(nodeVisual("pending", theme).backgroundColor);
    expect(running.labelColor).toBe(theme.colors.foreground);
  });

  it("checks off a completed node in the success colour", () => {
    const done = nodeVisual("completed", theme);

    expect(done.glyph).toBe("✓");
    expect(done.borderColor).toBe(theme.colors.statusSuccess);
    expect(done.lit).toBe(false);
    expect(done.labelColor).toBe(theme.colors.foreground);
  });

  it("flags a failed node in the danger colour", () => {
    const failed = nodeVisual("failed", theme);

    expect(failed.glyph).toBe("!");
    expect(failed.borderColor).toBe(theme.colors.statusDanger);
  });

  it("leaves a waiting node quiet rather than decorated", () => {
    const pending = nodeVisual("pending", theme);

    expect(pending.glyph).toBe("");
    expect(pending.borderColor).toBe(theme.colors.border);
    expect(pending.labelColor).toBe(theme.colors.foregroundMuted);
    expect(pending.lit).toBe(false);
  });

  it("gives every known run state its own readable treatment", () => {
    // A state that falls through to a blank label is a node the user cannot read.
    for (const state of DAG_STATES) {
      const visual = nodeVisual(state, theme);
      expect(visual.label, `state ${state} must carry a label`).not.toBe("");
      expect(visual.borderColor, `state ${state} must carry a border colour`).toBeTruthy();
    }
  });

  it("keeps an unknown future state renderable instead of blank", () => {
    const unknown = nodeVisual("teleported", theme);

    expect(unknown.label).toBe("teleported");
    expect(unknown.borderColor).toBe(theme.colors.border);
  });
});

describe("edgeVisual", () => {
  it("turns a satisfied dependency green and thickens it", () => {
    const fulfilled = edgeVisual(true, theme);
    const waiting = edgeVisual(false, theme);

    expect(fulfilled.color).toBe(theme.colors.statusSuccess);
    expect(waiting.color).toBe(theme.colors.border);
    expect(fulfilled.thickness).toBeGreaterThan(waiting.thickness);
  });
});

describe("progressPercent", () => {
  it("reports completion as a whole percentage", () => {
    expect(progressPercent({ completed: 1, total: 4 })).toBe(25);
    expect(progressPercent({ completed: 4, total: 4 })).toBe(100);
  });

  it("answers zero for a run with no nodes instead of NaN", () => {
    expect(progressPercent({ completed: 0, total: 0 })).toBe(0);
  });
});

describe("statusLabel", () => {
  it("keeps the Korean wording the card already shipped", () => {
    expect(statusLabel("running")).toBe("실행 중");
    expect(statusLabel("completed")).toBe("완료");
  });
});
